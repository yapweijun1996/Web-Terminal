# MCP and human collaborative terminal input: repair plan

Date: 2026-11-08. Source baseline: `37f790903e37fae3c429cf0ab0b5e4668c191cbb`.

**Outcome required:** an owner-authorized MCP client and the human can work in the same terminal. MCP must be able to type literal text and send supported keys, including an explicit Enter. A release that merely improves error messages while denying every input request does not meet this requirement.

**Status:** implementation and independent local/browser verification are complete in the isolated worktree under the owner's subsequent release authorization; publication and live activation follow the release gate. The dated investigation below records the initial baseline; final verification/publication and activation evidence are recorded in the execution update at the end. This document alone is not proof of a live capability. It supersedes the earlier *product recommendation* to keep all MCP input on indefinite HOLD, following the owner's explicit correction. The earlier report remains historical evidence of the code and release that actually shipped.

## 1. Findings from current source and live state

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Linux is currently running the PR #15 six-tool release, with input disabled | Live user unit and drop-in point to `mcp-20261108-input-errors-37f7909/mcp/server.js`, `WEB_TERMINAL_MCP_TOOLS=terminal-only`; MCP PID observed as `3472412`, active/running | Restore input in a focused six-tool release; do not deploy the full execution/job surface |
| The disablement has two layers | `mcp/server.js` tool wrapper throws `AUTHORITY_UNAVAILABLE`; the registered type/key callbacks also throw instead of calling the controller | Removing only one denial leaves input broken |
| Discovery also tells clients that input is unavailable | Server instructions and type/key descriptions in `mcp/server.js` | Metadata, callbacks, policy and tests must change together |
| The controller already implements literal typing and key delivery | `TerminalController.type()` uses a unique tmux buffer and `paste-buffer -p -d`; `key()` uses an explicit key allowlist | Reuse this implementation and its fencing rather than inventing a shell execution endpoint |
| Multiline/control rejection is independent of authority | `mcp/terminal-errors.js` rejects C0/C1, DEL and Unicode line separators before any controller action | Keep accurate `CONTROL_CHAR_OR_MULTILINE` diagnostics; do not automatically split a rejected paste into commands |
| Existing consent authorizes collaboration | `mcp-auth/consent-ui.mjs` says “Type and run commands” and “work alongside you”; scope is `terminal` | A validated delegation can authorize an application to act for the owner without making the application the owner |
| The public gateway checks delegation before collecting the body | `mcp-auth/server.mjs`: `/mcp` checks bearer/token, awaits up to 1 MiB of body, then proxies without another token check; `grant-store.mjs` supports expiry/revocation | Preserve authentication and close the body-wait revocation window with a deadline and pre-forward revalidation |
| The private MCP server receives sanitized proxy requests, not an authenticated grant identity | Gateway proxy forwards content type, accept, length and protocol version, but not the bearer or a trusted principal descriptor | Phase 1 can use the existing trusted-gateway boundary; per-client leases later require a real adapter contract |
| Current MCP operations are not serialized as a complete text/key operation | Controller methods are asynchronous; different requests can interleave select, buffer, guard and key work | Add bounded serialization or reject overlapping writes; unique buffers alone do not solve ordering |
| Typing/key methods currently select the target before writing | Both methods call `select()` | Input can change another view's selection. Separate input destination from view navigation for collaboration |
| Browser input bypasses the candidate input broker | `linux/ui/server.js` upgrades the WebSocket and pipes it directly to ttyd; xterm forwards `onData`/`onBinary` | An MCP-only lock cannot enforce human priority or prevent browser/MCP interleaving |
| Reusable arbitration code exists, but is not a production auth service | `runtime/gateway/broker.js` has connection-bound leases, generations, expiry and disconnect fencing; `collaboration-mvp` integrates it with test identities | Adapt broker semantics; do not install demo credentials or claim the broker authenticates users |
| The demo does not match this host's runtime | Demo explicitly requires tmux 3.6a and ttyd 1.7.7; observed Linux binaries are tmux 3.4 and ttyd 1.7.4 | Use Linux-specific disposable fixtures. Do not upgrade live runtimes simply to satisfy demo checks |
| Current tests deliberately enforce total MCP denial | `mcp/test/sdk.test.js` and `terminal-errors.test.js` expect every valid text/key request to fail | Passing those tests is evidence of the wrong product behavior, not collaborative input acceptance |

The original old-release symptom was real: newline/control input was rejected before sending, but the old server's generic catch mislabeled it as a changed target. PR #15 corrected diagnostics, then deployed unconditional input denial. These are separate issues; neither a stale-pane guess nor another error-only change repairs collaboration.

The live source, service state, deployment path and tool profile were rechecked on this host. No existing pane contents were read for this investigation. Historical Mac candidate memories were treated as references, not Linux deployment or authority evidence.

## 2. Correct authorization model

There are two different principals: the human resource owner and the delegated MCP application. The application does not need to impersonate the human to exercise a capability the human granted.

The existing Access-protected approval flow independently authenticates the browser and obtains explicit consent; the gateway then checks the issued delegation. Retain signature/issuer/audience/expiry verification, Origin/CSRF checks, exact callback allowlists, S256 PKCE, resource binding, absolute grant expiry and revocation. Do not issue a production grant on the owner's behalf.

The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) describes HTTP MCP requests made by a client on behalf of a resource owner. That supports the delegated-client model; it is not proof that this implementation is a sandbox or that each keystroke is a fresh human action.

A same-UID private Unix socket is a trusted local transport boundary, not proof of a separate owner OS identity. Code that already has the terminal's OS authority can access same-user resources. We will state that limitation rather than pretend a new environment flag or HMAC makes an untrusted AI process an owner.

The owner's latest instruction changes the desired product policy: allow explicitly delegated MCP input under the existing terminal grant. The old “no separately verified owner identity means no AI typing ever” policy must not be retained as an unrelated prerequisite. Stronger cross-principal confinement remains a separate design if requested; it is not a reason to silently disable collaboration.

## 3. Options and recommendation

| Option | Scope | Trade-off |
| --- | --- | --- |
| A | Restore delegated MCP text/key input and accurate errors, with bounded MCP write serialization | Fastest functional repair, but same-pane human/AI typing can still interleave through the direct browser path |
| **B — recommended** | Deliver A as an explicitly limited recovery, then add shared writer arbitration, owner pause/takeover and independent view selection | Restores actual usability promptly and completes reliable human/AI handoff without pretending an MCP-only lock protects browser input |
| C | First build a separately protected OS-principal input authority and per-operation owner attestations | Substantially larger privilege/provisioning work; changes the interaction model and is unnecessary for ordinary owner-approved delegation |

Implement B in reviewable stages. Do not make every character require another consent dialog. Do not describe stage 1 as collision-free simultaneous typing. The final goal is concurrent observation with coordinated writing and immediate owner control, not byte-level intermixing of two writers.

## 4. Stage 1 — restore authorized MCP typing and keys

### 4.1 Server-owned deployment policy

Introduce a narrowly named server configuration such as `WEB_TERMINAL_MCP_INPUT_MODE=disabled|delegated`.

- `disabled` remains the default for deployments that did not opt into delegated input. Invalid or empty values fail startup rather than selecting a broader mode.
- Explicitly configure the Linux six-tool release as `delegated`; leaving the live service disabled fails the recovery acceptance criterion.
- No tool argument, HTTP header, fake owner identity, tool profile, or terminal output may change this policy.
- `terminal-only` still exposes exactly the original six tools and never imports execution/job modules. Tool-set selection and input policy are separate concerns.
- HTTP deployment remains a private mode-0600 socket under an owned mode-0700 directory, reachable externally only through the existing bearer-validating gateway. No public unauthenticated listener is added.
- An explicitly configured stdio launch is controlled by the launching operator; do not imply HTTP OAuth magically protects arbitrary local stdio callers.

The configuration enables an already authenticated delegated capability. It is not itself evidence of a fresh owner action, and must not be presented as one.

### 4.2 Repair all API paths

Update `mcp/server.js` together:

1. Keep local text validation before any write and preserve typed/sanitized error handling.
2. In disabled mode, return the existing `AUTHORITY_UNAVAILABLE` response without consulting a target.
3. In delegated mode, call `controller.type(target, text)` and `controller.key(target, key)` rather than the two throwing placeholders.
4. Advertise the actual mode in instructions and tool descriptions. Enabled descriptions explain literal text, explicit separate Enter, shared destination and no automatic retry.
5. Keep the existing result contracts: text returns `{sent:true, submitted:false}`; Enter returns `{sent:true, submitted:true}` after dispatch; other keys return `submitted:false`.
6. Treat these results as dispatch acknowledgements, not proof that a command succeeded or a particular TUI interpreted input as intended.

### 4.3 Preserve identity, scope and literal-input guarantees

Continue checking server PID, session ID, window ID and pane ID before delivery and inside tmux's guarded command queue. Preserve Linux `shared`/`web-<12hex>` session scope and copy-mode refusal. Do not substitute “currently active pane” or silently refresh a target on a mutating operation.

Use buffer/argv paths for text; never interpolate user text into tmux command strings or a shell. Shell metacharacters remain literal terminal data until the target application interprets them; command classification cannot turn the shell into a sandbox.

Retain the 8192-byte UTF-8 bound, unique buffers, cleanup on all exits, explicit key allowlist and no automatic Enter. A guard failure or uncertain transport result must not trigger an automatic retry. Distinguish validation rejection, target mismatch, local busy state and uncertain dispatch using fixed diagnostics.

Add process-generation evidence only if tests establish a missing replacement fence. Preserve current four-field target compatibility; do not blindly pin a foreground command's PID, which legitimately changes as a shell starts a job. Assess same-pane respawn and server-PID reuse explicitly; never claim stronger restart protection than verified.

### 4.4 Serialize writes and stop implicit focus changes

Use one process-wide controller-owned bounded write coordinator, not a new queue per HTTP `createServer()` call. Coordinate the whole type/key mutation on the captured target. Prefer rejecting an overlapping operation with `INPUT_BUSY` over silently buffering unbounded delayed writes. Release the coordinator in `finally`; bound execution and queue memory.

Keep `terminal_select` as the explicit view-navigation operation. Refactor typing/key delivery to validate and write the captured target without implicitly selecting another pane/window. Update the old autofollow regression to test this intentional collaboration behavior. Explicit select and grouped-view compatibility retain their existing tested behavior.

This serializes individual MCP mutations only. It does not reserve the interval between a text call and a later Enter call: A:text, B:text, A:Enter can still occur across clients, and the human can still write through direct ttyd. Stage 1 must disclose both limitations and test sequential handoff in a disposable pane. It must not claim a command transaction, browser interception, or mixed-command prevention. Stage 2 leases plus request-carried generations protect a multi-call continuation.

### 4.5 Grant lifetime and revocation semantics

Every new external request must still pass gateway token/expiry/revocation validation. Invalid, expired, revoked or absent bearer must not reach the controller.

The inspected gateway validates the token before awaiting the request body. Add a bounded body-read deadline (proposed server-owned limit: 5 seconds, tested with slow/aborted input) and revalidate the same token immediately after the complete bounded body is collected and before creating the upstream request. Return a sanitized timeout/401 response and forward zero bytes if that check fails. Do not extend grant expiry, cache an old authorization success, or introduce an alternate bypass for retries. Add a test that withholds the final body bytes, revokes/expires the grant, then completes the body and observes zero upstream writes.

Define authorization acceptance as the final successful check immediately before forwarding, not the initial bearer-shape check. Stage 1 cannot retract a request already forwarded, bytes already delivered, or a running command. Avoid deep write queues that extend accepted work. Test revocation before a subsequent text or Enter and disclose the remaining in-flight boundary. Strict cancellation of queued writes belongs to the shared authority in stage 2; do not promise instantaneous cancellation in stage 1.

**Stage 1 completion:** actual authenticated MCP text, supported keys and explicit Enter work in a disposable terminal shared with an owner/browser view; invalid/revoked requests send zero bytes; the six-tool release is preserved. Valid text must not return `AUTHORITY_UNAVAILABLE` merely because the caller is an AI application.

## 5. Stage 2 — coordinated writing and owner takeover

### 5.1 One authoritative broker for managed writers

Adapt `runtime/gateway/broker.js` rather than create a second independent lease implementation. Preserve its monotonic TTL, epoch/generation, target snapshot, connection binding, disconnect invalidation and revalidation-before-execute semantics.

The production broker must be shared by the OAuth/MCP adapter and the browser adapter. Separate per-process Maps in UI and MCP are not shared authority. Place it behind one private service/adapter boundary with bounded requests; document trust in the owning OS account rather than claiming cross-principal isolation.

Obtain MCP client/grant identity from the gateway's validated grant record, never a client-supplied role, email, UID, PID or header. Add a server-side token-to-grant lookup that returns only the minimum identity/capabilities to the trusted adapter. Do not forward bearer tokens into arbitrary tool bodies or logs. Review grant revocation/expiry notification and broker disconnect behavior before enabling leases.

Authenticate owner-control requests through the existing Access-verifying approval boundary plus Origin/CSRF protection. The UI's per-process request token alone is not owner authentication. Prefer controls on an already routed protected endpoint; if a new tunnel route is required, treat that as a separate explicitly authorized tunnel change rather than restart it implicitly.

### 5.2 Capture both input paths

The current raw WebSocket pipe is not an arbitration hook. Prototype a managed browser adapter, retaining read/resize/output behavior while routing **all managed input** through the broker. The demo's read-only ttyd watcher plus broker-controlled input provides prior art, not a ready-to-deploy authentication layer.

Preserve WebSocket masking, fragmentation, binary frames, Unicode, control sequences, resize, TUI behavior and backpressure in the real Linux fixture. Do not write a partial byte-sniffing proxy that silently corrupts frames or passes an alternate raw-input route. Inventory and migrate legacy writable views; a writable path that bypasses the broker must not be labeled coordinated.

Guarantees cover broker-managed connections. Direct OS/tmux clients under the same account can still write and remain outside that guarantee. Keep human direct access available as recovery without claiming those writes can be intercepted by an in-process broker.

### 5.3 Small handoff contract

- Both actors can observe shared output; selecting a view does not grant write authority.
- A managed target has one current writer generation. Only authenticated adapters can claim/renew/release it.
- The owner can pause AI writing or take over. AI cannot obtain owner/takeover capability by requesting a role.
- Owner pause invalidates the relevant generation immediately, before waiting behind a slow input operation. The existing broker's queued `claim()` alone is insufficient for this priority guarantee; adapt immediate invalidation as used by `disconnect()` and recheck before dispatch.
- Human input/takeover invalidates any pending AI submission continuation. A delayed AI Enter must not submit text the human edited after the AI typed.
- Disconnect, grant revocation, expiry, restart or target replacement invalidates pending authority. No old proof can be replayed into a new connection, process epoch or pane.
- Already delivered bytes/running commands cannot be undone. A pause request immediately stops admission and invalidates generations; it is distinct from a confirmed pause. Commands already dispatched toward tmux may still deliver. Send a confirmed pause acknowledgement only after outstanding executor work has drained or been fenced at the actual delivery boundary. If completion is uncertain, keep writes blocked and report pause-pending/unknown rather than claiming a completed pause. Resume cannot silently clear an unresolved in-flight outcome. Pause does not kill processes or inject Ctrl-C.
- If target/auth state or the broker is unavailable, fail the affected mutation accurately. Reads and human recovery remain usable where possible.

Retain the existing six public MCP tools for the first recovery. Stage 2 retains their names but must version the mutation target contract: a coordinated-mode target includes a broker-issued `inputGeneration`, returned by discovery/listing and echoed on each text/key request. Require it in coordinated mode, bind it to the authenticated grant/lease and captured target, and reject old or missing generations rather than filling in the current one. Generation is a freshness fence, not owner identity or authority. Owner takeover and resume each rotate it. This prevents an old delayed Enter from silently reacquiring a fresh lease after human editing/resume. A grant-bound server Map alone cannot distinguish those requests in the current stateless protocol.

Advertise that schema change accurately, update SDK/browser tests, and require clients to rediscover/reconnect when needed. No automatic re-list-and-retry is permitted for mutations. A new public acquire/release tool, if ever needed, is a separate explicit interface expansion; six tool names alone do not prove unchanged semantics.

### 5.4 Owner-visible controls

Show the writer and target, AI-active/paused state, and an accessible **Pause AI / Take control / Resume sharing** control in the terminal UI. A pause acknowledgement must come from the authoritative broker, not a cosmetic browser flag. Owner typing wins through the managed handoff path; AI resumption requires a deliberate owner sharing action after takeover.

Use normal product wording, SVG icons, keyboard operation and clear status. Do not expose PIDs, tokens or implementation details as product prompts. Keep observers read-only and preserve independent tab selection.

**Stage 2 completion:** an owner browser and MCP client share output; confirmed owner takeover follows draining/fencing of in-flight work and prevents later AI text/key delivery, stale AI Enter is rejected, and managed paths cannot bypass arbitration. Do not declare collision-free collaboration until both real paths satisfy this test.

## 6. Multiline content is a separate input contract

The immediate collaboration repair enables single-line literal text and supported keys. Rejected multiline input must explain the problem without recommending automatic command splitting.

For future multiline data, prefer a previewed editor/file workflow. Any terminal-paste API must distinguish data insertion from submission, bind the exact target and content, and demonstrate the destination's paste behavior. Bracketed paste is an application convention; it does not guarantee that a shell/TUI will treat embedded newlines as non-executing data.

Never silently convert one multiline request into a sequence of text+Enter calls, strip controls and send a prefix, or execute content to “test” it. This limitation must not block ordinary text, Enter, navigation, Tab or Ctrl-C cooperation.

## 7. File-level implementation map

| Files | Planned change |
| --- | --- |
| `mcp/server.js` | Explicit disabled/delegated policy; real controller callbacks; honest tool metadata; preserve six/full tool profiles |
| `mcp/terminal.js` | Bounded controller-level mutation coordination; preserve in-tmux guards and buffer cleanup; separate input from view selection |
| `mcp/terminal-errors.js` | Keep sanitized input/stale/authority diagnostics; add a distinct fixed busy outcome if needed; update text so it does not claim all MCP input is permanently unavailable |
| `mcp/test/sdk.test.js` | Keep explicit disabled-mode negative tests; add enabled positive text/key tests and mode-independent fencing |
| `mcp/test/terminal-errors.test.js` | Parameterize policy/profile; retain complete control validation, no-partial-input, replay, race, copy-mode and minimal-package coverage |
| `mcp/test/http.test.js` | Verify both transport policies, six-tool inventory and Origin rejection |
| `mcp-auth/server.mjs`, `mcp-auth/server.test.mjs`, `grant-store.test.mjs` | Bound body-read time; revalidate before proxying; real gateway-to-fixture authorization; absent/forged/expired/revoked grants, slow-body revocation and later Enter refusal |
| `mcp-auth/consent-ui.test.mjs`, browser fixtures | Keep truthful collaboration permissions; require native and cross-origin regressions for auth-related changes |
| `runtime/gateway/broker.js`, `tests/input-broker.test.js` | Stage 2: immediate owner invalidation, bounded work and reliable grant/connection lifecycle; retain existing lease invariants |
| `linux/ui/server.js`, `linux/ui/app.js`, related browser/client code | Stage 2: real managed writer adapter, authoritative owner controls, independent views and migration from direct writable relay |
| `collaboration-mvp/*` | Prior art only; no demo token/role provisioning or Mac-specific runtime dependency copied into production |
| `mcp/README.md`, `docs/shared-terminal-mcp.md`, `docs/mcp-connection-runbook.md`, prior review | Reconcile actual mode, delegation semantics, host-specific release, limitations and verified results; preserve historical evidence as dated history |

## 8. Required regression matrix

| Scenario | Required result |
| --- | --- |
| Delegated mode, valid OAuth grant, disposable pane | Literal Unicode/quotes/metacharacter text delivered once; `submitted:false` |
| Explicit subsequent Enter | Supported key dispatched once; no automatic Enter on text |
| Human then MCP then human in the same disposable cat/editor | Both paths remain usable and output is shared |
| Owner working in another pane/view | MCP writes only captured target; no implicit focus hijack or spillover |
| Supported navigation/Tab/Backspace/Ctrl-C | Correct real terminal behavior, tested only in owned disposable fixtures |
| Disabled mode or unknown policy value | Mutation denied before target access, or invalid configuration fails startup |
| No/forged/expired/revoked token, including revocation/expiry while the body is withheld | Gateway rejects at final pre-forward check; slow body times out; controller spy and pane snapshot show zero write |
| Client claims owner role, changes tool profile or sends fake authority headers | No elevation or policy change |
| LF, CRLF, every C0/C1 control, DEL, U+2028/U+2029 | Entire text rejected, accurate code, zero partial input |
| Invalid UTF-8 byte length boundary, ordinary Unicode at limit | Rejection/acceptance follows byte contract, no truncation |
| Server/session/window/pane mismatch and Linux out-of-scope session | No write, no active-pane fallback |
| Pane replacement, same-name session recreation, copy-mode, target lost after buffer creation | Guard fails; buffers cleaned; no retry or spillover |
| Same-pane respawn and potential PID reuse | Explicitly verified identity semantics; no unsupported stale-proof guarantee |
| Concurrent MCP text/key on one target | Stage 1: individual operations are bounded/serialized or busy-rejected; no text-plus-Enter transaction claim. Stage 2: the writer lease and echoed generation reject another writer/stale continuation |
| Timeout, lost response, client retry or duplicate mutating request | No automatic replay; outcome uncertainty reported; do not claim application exactly-once without a real deduplication contract |
| Six-tool minimal release with no execution module | Starts in declared profile, exact inventory, no job registry or execution fallback |
| Stage 2 owner pause during verification, queued work, or an already-dispatched delayed executor | Admission stops immediately; pending operations are fenced; confirmed pause waits for outstanding delivery to drain/fence. Unknown delivery never receives a false confirmed-pause ack |
| Stage 2 human edits between AI text and delayed Enter, including pause then resume | Old `inputGeneration` rejected; no implicit fresh lease/generation substitution; human text not submitted by stale Enter |
| Stage 2 stolen/expired/replayed lease, disconnect, revoked grant, broker restart | Proof rejected; read/owner recovery behavior remains documented |
| Stage 2 browser binary/fragmented input, resize, full TUI and legacy writable routes | Protocol behavior preserved; no bypass mislabeled as coordinated |
| Native/cross-origin consent | Real browser Allow/Deny/Revoke, callback arrival, issuer/state, PKCE and MCP discovery pass |

Use real disposable tmux servers with private `TMUX_TMPDIR` and `/bin/cat` or an explicit test editor/process. Synthetic authority fixtures must be labeled test-only. Do not test shell snippets, Ctrl-C, keys or text against existing user panes. Never log request queries, bodies, headers, tokens, cookies or terminal contents.

A genuine positive SDK and authenticated gateway input test is mandatory: repeating denial tests cannot count as recovery success. Independent review must assess both working input and denied unauthorized input.

## 9. Release and rollback

1. Keep implementation in `/home/ai-agent/worktrees/web-terminal-collaborative-input-20261108`, branch `codex/yap-collaborative-input-20261108`, based on fetched main. Preserve the original checkout and all unrelated work.
2. Implement stage 1 with its tests and truthful docs. Inspect the exact diff; obtain independent security review. Run MCP, gateway, consent and Linux collaboration fixtures appropriate to changed paths.
3. Commit and publish through a PR under the existing owner authorization, verifying the exact head SHA and merge result. Do not force-push main or merge untested unrelated work.
4. Package a new private, versioned six-tool release from the merged commit. Include only required source/package files and verified dependencies; exclude execution/job implementations.
5. Run the actual package against an isolated tmux fixture with `terminal-only` plus `delegated`. Require positive text and separate Enter, shared output, invalid input/auth refusal, stale/guard checks and private-socket Origin rejection.
6. Back up precise MCP/gateway units, drop-ins, old releases and private grant-state recovery metadata without exposing keys/tokens. Verify live gateway source/config before applying the narrow body-deadline/revalidation change; preserve its current durable state paths and grant policy. Record service PIDs and pane/process identities without contents. Recheck dependency graphs and pending jobs.
7. Activate the narrowly changed gateway first while MCP is still disabled, verify unchanged OAuth behavior, then activate the six-tool MCP component with delegated mode. Only these changed services need restart; preserve durable registered clients/grants and their original expiry, UI, ttyd, tmux and Tunnel. Gateway restart invalidates unfinished approval/code flows; disclose that and do not issue replacement grants for the owner. Inspect each active unit/job after a timeout before deciding whether another operation is needed.
8. Verify live initialization, exact six tools, normal-DNS metadata and no-bearer 401 separately. With an actual existing authorized connector, create/use only a clearly disposable smoke target and prove text plus explicit Enter. A harmless `/bin/cat` fixture should be provisioned by the operator, not by auto-running a pasted shell command. Remove only that fixture after recording results.
9. Compare existing pane IDs/process start times and unrelated service PIDs; verify direct human input in the disposable shared view. Publish exact source SHA, test exit codes and remaining stage-1 interleaving limits.
10. Stage 2 requires its own reviewed broker/UI migration, real browser acceptance and component-specific activation. Do not hide a UI or tunnel change inside this focused input/gateway update. Any tunnel restart still needs explicit authorization.

Rollback is component-specific: restore only the failed component's previous drop-in/release after inspecting live jobs. Restore MCP independently of the gateway, and preserve the current durable grant store/key and grant policy when reverting gateway code. The previous MCP release disables AI input; report that loss of functionality explicitly. Prefer a configuration-only pause/disabled mode for emergency recovery, keep human direct access available and preserve all sessions. Never roll back durable grant state or revoke all clients as an input-repair shortcut.

## 10. Evidence gathered for this plan

Source inspection and live read-only unit checks confirmed the findings above. At investigation time: Linux MCP was active on the PR #15 release, with two previously recorded existing panes; other terminal services were active. No runtime input policy was changed for this plan.

Fresh baseline checks on this Linux host:

- `node --test tests/input-broker.test.js`: exit **0**, **3 passed**, no failures/skips. These test the in-process broker, not production authentication or browser mediation.
- Full MCP baseline (`npm test` in `mcp` with private fixture TMUX_TMPDIR): exit **0**, **117 discovered, 86 passed, 31 existing Darwin-only skips, 0 failed**. This suite currently expects disabled input, so green status is not completion of the requested repair.
- OAuth baseline (`npm test` in `mcp-auth`): exit **0**, **21 passed**, no failures/skips. No live owner grant was issued by tests.
- The Mac-specific collaboration demo was inspected, not accepted as a Linux end-to-end result; its runtime version requirements do not match this host.

Independent plan review identified and resolved four specification gaps: an echoed generation is required to reject delayed requests after takeover/resume; per-operation serialization is not a text+Enter transaction; a confirmed pause must wait for in-flight delivery to drain/fence; and gateway body collection needs a deadline plus final token revalidation. The existing broker tests do not establish these new guarantees. Final independent read-only review: **GO for this plan**, no additional required corrections; independent `git diff --check` exit **0**. This is not implementation or deployment acceptance.

At the time this plan was drafted, new stage-1/stage-2 tests, positive live collaborative input and deployment of this repair were **not done**. The following execution record supersedes that planning-time status. No implementation percentage or delivery-time estimate is asserted. The next implementation target is the stage-1 positive acceptance contract, not another denial-only release.


## 11. Execution update under Auto Manager

The owner authorized autonomous implementation, independent verification,
commit/merge/push and live deployment. Coding was delegated to isolated MCP,
auth and UI worktrees; the manager inspected and integrated actual commits.
The original `/home/ai-agent/Web-Terminal` checkout remains preserved.

Implemented source contracts:

- Working delegated text/key callbacks, separate Enter, no implicit view focus,
  physical-pane busy rejection and immutable target/options snapshots.
- Strict coordinated mode, request-scoped AsyncLocalStorage admissions, exact
  operation digest binding, current generation and no authority fallback.
- One private UI coordinator reusing InputBroker, server-owned session/pane
  identities, pane-process guards, conservative owner-wide AI pause and explicit
  per-session resume. Real tmux session switching demonstrated that URL-bound
  pause alone could leave the actual destination writable; native human input
  now invalidates all managed sessions before forwarding.
- Bounded body deadline and final token revalidation; fresh private grant lookup
  in the final `beforeDispatch` hook; confirmed revocation waits for draining.
- Monotonic admission deadlines rechecked after asynchronous work; writer expiry
  rotates generation rather than silently reauthorizing old Enter.
- Independent signed Access identity for controls/WebSockets, CSRF/Origin checks,
  native binary/fragmented ttyd transport and mediated image-path insertion.
- Guarded ttyd/xterm protocol-response provenance, conservative unknown fallback,
  and startup-failure cleanup so no writable coordinator survives an unusable UI.

The independent security review found and prompted fixes for revocation failure,
in-flight drain, admission expiry during waits, lease continuation after writer
change, startup partial initialization, false human takeover on native
terminal protocol replies, and native tmux client session switching. All reported P1s require verified closure before
publication. Baseline denial tests are not counted as positive feature proof.

Final independently rerun checks before publication:

| Check | Actual result |
| --- | --- |
| MCP suite | Exit 0; 135 discovered, 104 passed, 31 existing Darwin-only skips, no failures |
| OAuth suite | Exit 0; 40 passed, no failures/skips |
| Linux plus input-broker suite | Exit 0; 97 passed, no failures/skips (Linux alone 94) |
| Full native integration | Real signed-owner OAuth/PKCE to MCP/UI/tmux/ttyd, plus native cross-session switching regression passed |
| Real Chromium owner UI | Exit 0; text/Enter, keyboard, paste, mobile Tab, Pause/Takeover/Resume, native CPR/DA replies and stale Enter passed |
| Native/cross-origin consent browser regressions | Both exit 0; callbacks, issuer/state and PKCE retained |
| Independent adversarial review | 21 targeted tests passed; original cross-session exploit independently reproduced as fixed; no observed remaining P0/P1 |
| Viewports | Desktop 1280px and mobile 390px; no horizontal document overflow |

The full diff check found one trailing whitespace in the provenance adapter; it
was removed without changing behavior. Earlier failing browser checks exposed real
vendor interoperability problems (false protocol takeover and missing legacy
`term.input()`), which were fixed and covered by passing actual-browser tests.

Package identity, merged release commit, backups and actual live results are
retained in `artifacts/release/deployment.md` after activation. No production grant is issued for a
fixture, and no fixture owner identity is used on production.
