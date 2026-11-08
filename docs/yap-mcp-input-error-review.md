# YAP Terminal MCP input error review — 2026-11-08

Initial local-only review: **GO for diagnostic code; HOLD for privileged input and multiline input.** The first task stopped before any commit or deployment. The owner subsequently authorized commit, merge, push and live deployment; the release follow-up below supersedes the initial deployment HOLD.

## Baselines and verified cause

- Host: `yapvmmcp`; original checkout `/home/ai-agent/Web-Terminal` remains clean on `c25b61e3912f6d3152cbbf3875573dae965ee9e3`.
- Fetched `origin/main`; original checkout is one commit behind. Upstream `d39e87c` adds mobile keyboard UI/tests, not a replacement input authority.
- Isolated worktree: `/home/ai-agent/worktrees/web-terminal-input-errors-20261108`; branch `codex/yap-input-errors-20261108`, based on `d39e87c`.
- Live user unit `linux-web-terminal-mcp.service`: active/running, MainPID `119663`. `/proc/119663/cmdline` names `/home/ai-agent/.local/share/linux-web-terminal/releases/mcp-20261107-161418/mcp/server.js`; cwd `/home/ai-agent`.
- Inspected released files: `terminal.js` rejects C0/DEL (including newline) before select/buffer/paste; `server.js` catches every controller exception and returns the same misleading “Operation unavailable or target changed” message.
- Current source intentionally denies both MCP input tools before consulting any target. This is a separate owner-authorization boundary; a working list/read does not establish input authority or imply a stale pane.
- Existing live list/read success is supplied incident evidence. This task did not capture existing terminal contents or send input to existing panes. List/read compatibility was reproduced through the actual SDK in disposable fixtures, not inferred from metadata.
- KB recall returned historical Mac owner-input candidate context. It was treated as reference material, not evidence of Linux authority or authorization to enable input. The MCP connection runbook was read.

## Patch behavior

- `mcp/terminal-errors.js`: branded typed errors and fixed, sanitized public diagnostics. Untrusted exception messages and forged error codes cannot select or contaminate a response.
- `CONTROL_CHAR_OR_MULTILINE`: rejects the complete input before any target lookup or tmux action. Guidance says nothing was sent, directs multiline content to the owner's direct editor/terminal, and explicitly forbids automatic splitting into typing/Enter calls.
- `AUTHORITY_UNAVAILABLE`: valid text and every supported key remain unconditionally denied before any controller call. Invalid or missing targets do not trigger target probing on this path.
- `STALE_TARGET`: reports failed target validation or the existing tmux guard rejection, including copy-mode. It does not assert a uniquely diagnosed stale pane or successful/unsuccessful delivery of a prior operation; automatic retries remain forbidden.
- `INVALID_INPUT` and `INVALID_TARGET` distinguish controller validation failures. Unknown exceptions become `OPERATION_UNAVAILABLE`; raw subprocess errors, input, tokens, and terminal contents are never echoed.
- Controller PID/session/window/pane checks, Linux session-name scope, copy-mode condition, paste flags and buffer cleanup are preserved. No authority adapter, consent bypass, owner identity claim, new tool, execution fallback, or enabling flag was added.
- Compatibility: the MCP tool names, schemas, eleven-tool inventory and text/error envelope stay unchanged; successful list/read/controller input results are unchanged. Error text now has a stable code prefix. C1 controls U+0080–009F and Unicode U+2028/U+2029 line separators are additionally rejected; ordinary Unicode text remains allowed up to 8192 UTF-8 bytes in the controller.

## Validation and independent review

| Check | Exit code | Evidence |
| --- | --- | --- |
| `node --check mcp/server.js` | 0 | Syntax valid |
| `node --check mcp/terminal-errors.js` | 0 | Syntax valid |
| Initial new targeted suite | 1 | 5 passed; fixture cleanup attempted to kill an already stopped disposable server; corrected cleanup bookkeeping |
| Final `node --test mcp/test/terminal-errors.test.js` | 0 | 6 passed, 0 failed, 0 skipped |
| Full `npm test` in `mcp` with fresh private `TMUX_TMPDIR` | 0 | 114 discovered, 83 passed, 0 failed, 31 skipped; skips are existing Darwin native peer-credential tests on Linux |
| Independent reviewer targeted rerun | 0 | 6 passed, 0 failed, 0 skipped |
| Independent adversarial validator/error assertions | 0 | Controls, UTF-8 boundary, forged/mutated errors and sanitization |
| `git diff --check` | 0 | No whitespace errors |

New tests cover every C0 and C1 control, DEL, LF/CRLF and Unicode line separators; byte limits and ordinary Unicode/literal text; no controller action for invalid input; no partial input; all four identity fences; replay of an old target after pane replacement; target loss after buffer creation and cleanup; copy-mode guard; repeated MCP input and key denial; no target probing even when the tmux server is absent; unchanged list/read and eleven-tool discovery; and sanitized fallback errors. Direct controller positive input is confined to disposable `/bin/cat` panes and does not establish MCP authorization.

Independent read-only security review found no blocking findings. Its constructor-normalization suggestion was applied and reviewed again. Verdict: GO local diagnostic patch / HOLD privileged input, multiline input and deployment.

Tests used random dedicated tmux servers and private temporary directories. Existing sessions were not used. The original checkout was rechecked clean and the production PID remained `119663`. OAuth, public reachability and actual hosted-client acceptance were not retested or claimed by this local task; authentication and consent flows are unchanged.

## Smallest safe privileged design — HOLD, not implemented

1. Keep MCP input denied until a separately protected broker can attest a real owner action through an independently authenticated owner UI. The AI/MCP principal must not approve its own request or supply a trusted identity. Existing OAuth access, claimed UID/PID, owner headers and same-UID secrets are insufficient owner attestation.
2. The owner reviews the exact bytes and intended destination. Bind a one-use approval to the full content digest, action, authenticated caller/connection, server process generation, session/window/pane identities, nonce and a short monotonic expiry. Denial, timeout, revocation, mismatch or verifier unavailability sends zero bytes. Consume approval atomically with final target revalidation; preserve existing fencing and no automatic retry after an uncertain result.
3. For multiline content, first use a preview/file or editor destination without terminal submission. A terminal paste, if later supported, needs its own explicit approval and a destination verified safe for multiline data; bracketed paste alone does not make an arbitrary shell safe. Never auto-run pasted shell commands or silently split lines into input/Enter calls. Enter/submission requires a separate exact-action approval.
4. Before enabling anything: independently review broker isolation and credential ownership, replay/expiry/race handling, refusal paths, safe recovery and audit redaction using disposable fixtures. Real owner approval and demonstrated protection from the MCP principal remain missing. No enabling implementation is included here.

## Review artifacts

The initial local patch and fixture-only test logs were saved under ignored `artifacts/`. The committed diff is authoritative after publication; release evidence is retained separately under `artifacts/release/`.

## Authorized release follow-up

The owner requested commit, merge, push to GitHub main and live deployment after the initial local-only review. The target remains the Linux MCP service; the original checkout is preserved.

To preserve the pinned six-tool deployment without introducing the full source runtime's execution/job tools, `WEB_TERMINAL_MCP_TOOLS=terminal-only` selects exactly the existing six terminal tools. `full` remains the default for existing source users. Unknown/empty values fail startup. Execution registration/shutdown moved unchanged into `execution-tools.js`, dynamically imported only by `full`. The Linux release is packaged from merged source with only `server.js`, `terminal.js`, `terminal-errors.js`, package files and verified dependencies; it does not contain execution/job implementation modules. Misconfiguring this minimal package to `full` therefore fails startup rather than expanding capabilities.

Both profiles keep unconditional input denial. Live single-line text and keys will return `AUTHORITY_UNAVAILABLE`; rejected multiline/control content returns `CONTROL_CHAR_OR_MULTILINE`. This is the deliberate owner-authorization boundary, not restored privileged typing. Owner browser/tmux input is unaffected.

Final pre-publication evidence:

| Check | Exit code | Evidence |
| --- | --- | --- |
| Targeted SDK/HTTP/package tests | 0 | 10 passed, no skips/failures |
| Full MCP suite | 0 | 117 discovered; 86 passed, 31 existing Darwin-only skips, no failures |
| OAuth suite | 0 | 21 passed, no skips/failures |
| Native HTTPS browser consent | 0 | Reproduced old null-Origin 400; current Deny/Allow 302, Revoke 303 |
| Cross-origin HTTPS browser consent | 0 | Reproduced old blocked callback; current Deny reaches callback, Allow exchanges token and discovers MCP |
| Independent final SDK/HTTP/package rerun | 0 | 10 passed, no skips/failures; six-tool package/security plan GO |

The first optional OAuth/browser attempts failed because the isolated worktree lacked `mcp-auth/node_modules` (`jose` missing). Copying the existing dependencies into this worktree resolved the environment issue; the final runs above passed. No production gateway configuration or callback policy changed.

Activation plan: preserve the old release and unit as rollback evidence, record pane/process identities, create a private versioned minimal release from merged main, verify an isolated canary, install an MCP-only systemd drop-in selecting `terminal-only` and the new release, reload user units and restart only `linux-web-terminal-mcp.service`. Verify private initialization, exact six-tool discovery, sanitized denial/stale errors, HTTP Origin rejection, public metadata and unauthenticated challenge, plus unchanged pane identities and unrelated service PIDs. Do not restart Tunnel, OAuth, UI or tmux. A separate release record must state actual activation results; this pre-publication report does not assert live deployment or hosted-client acceptance.
