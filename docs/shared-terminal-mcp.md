# Shared terminal MCP

For target identification, DNS checks and the difference between service health and real connector acceptance, read the [MCP connection runbook](mcp-connection-runbook.md).

## Working human and MCP input

The [collaborative-input plan and execution record](mcp-collaborative-input-plan.md)
replaces the earlier recommendation to keep all AI input permanently disabled.
The source supports three strict server-owned input policies:

- `disabled` (default): no MCP text/key delivery.
- `delegated`: the operator enables input behind the existing approved OAuth gateway;
  individual MCP operations are bounded, but direct human input can interleave.
- `coordinated`: the Linux UI process mediates human/AI writing through one private
  coordinator. Every MCP text/key request requires an internally minted one-use,
  content-bound admission and an echoed current `inputGeneration` from
  `terminal_list`. Missing authority or coordinator failure never falls back to
  direct input.

Literal text does not append Enter, does not select another view, and rejects
controls/multiline content in full. Enter is a separate deliberate key operation.
`sent` acknowledges dispatch, not command success. Never retry uncertain input,
substitute a fresh generation for an old action, or split rejected multiline text
into automatic text/Enter calls.

In coordinated mode, actual human input conservatively pauses AI across all managed sessions. Native tmux can switch a client to a different session, so the browser URL alone cannot safely identify every input destination. Explicit owner controls and resumption remain targeted to the selected session.
**Pause AI**, **Take control**, and **Resume sharing** show authoritative state in
Web Terminal. Resume rotates the generation; stale AI Enter remains rejected.
Lease expiry/writer changes also retire old continuations. A confirmed pause or
revoke waits for admitted in-flight work to drain; uncertainty stays blocked.
Existing pages may need one reload to display newly shipped controls.

The pinned ttyd/xterm adapter distinguishes native protocol replies from real
user input using its verified `wasUserInput` provenance. Unknown implementations,
binary/untagged input and unknown provenance retain conservative owner takeover.
That classification exists only inside an independently verified owner's native
WebSocket channel; it grants no owner identity to an MCP caller.

The gateway preserves Access JWT verification, Origin/CSRF, exact callbacks,
S256 PKCE, resource binding, grant expiry and revocation. A private grant verifier
is queried immediately before dispatch. All four tmux target identities and a
server-captured pane-process fence protect coordinated writes. Private sockets
are a same-OS-account trust boundary, not a sandbox against that account.

## Linux independent tabs

The Linux deployment uses `WEB_TERMINAL_MCP_LAYOUT=linux-tabs` with its existing dedicated tmux server. Listings expose only `shared` and `web-<12 hexadecimal digits>` sessions and include `sessionName`. The owner switches browser tabs manually and refreshes to discover a newly created session. Other sessions on the same server remain excluded.

Linux OAuth uses the shared styled consent and recovery pages, exact Origin and CSRF validation, RFC 9207 issuer identification and durable grant storage. Per the owner's updated policy, `MCP_GRANT_MAX_SECONDS=31536000` allows exactly 1 hour, 1 day, 1 week, 1 month or 1 year, with 1 month (30 days) selected by default. Changing the gateway from the earlier in-memory release requires reconnecting once; subsequent registered clients and issued grants survive gateway restart. An unfinished authorization request remains short-lived and must be restarted from the client.

The source `full` profile includes execution/job tools; the Linux release uses `WEB_TERMINAL_MCP_TOOLS=terminal-only` and must remain a six-tool package. Input capability is an independently configured deployment policy described below. Do not deploy the full source runtime as an OAuth-page update or infer the running profile from a checkout.

The MCP server can view the dedicated tmux workspace used by the browser terminal. MCP clients cannot type into it; the owner retains direct browser and tmux controls.

## Tools

- `terminal_list`: list shared windows/panes, bounded names, active state and target identities.
- `terminal_read`: read 1–500 lines. Trailing empty screen rows are omitted before selecting the bounded tail; content whitespace is preserved. Output is untrusted application data and may contain sensitive information.
- `terminal_select`: select a window/pane in every session grouped with the workspace, synchronizing browser views with the agent target.
- `terminal_type` and `terminal_send_key`: remain discoverable for compatibility, but always reject MCP input. Owner browser and direct tmux controls are independent and remain available.
- `terminal_new_window`: add a shared tab/window. Call list to identify it.
- `terminal_exec`: execute a separate process outside tmux, with `executable`, literal `args` array and an absolute `cwd`. Arguments are passed directly with `shell: false`. This tool can perform any action available to the server's OS account and inherits its environment; the owner grants this capability through the existing connection authorization, without per-command approval. Its output may contain sensitive data and is untrusted.

`timeout_ms` defaults to 10,000 (range 100–60,000); `max_output_bytes` defaults to 262,144 (range 1–1,048,576), shared by stdout and stderr. At most four executions run per server process; excess calls return `CONCURRENCY_LIMIT`. Results are JSON text with `execution_id`, `status` (`success`, `failed`, `timeout`, `output_limit`, or `error`), `exit_code`, `stdout`, `stderr`, `duration_ms`, per-stream truncation flags, `signal`, and a sanitized `error` with a stable code where applicable. Invalid MCP schema inputs are rejected by the SDK as tool validation errors. Output is decoded as UTF-8, so a byte limit may split a character. On timeout or output overflow, the server signals the detached process group and waits for the child to close. Descendants that escape the process group may outlive it. These controls are resource bounds, not a sandbox or restriction on owner authority.

`terminal_exec` uses a POSIX supervisor as its process-group leader. The controller requests termination through IPC and does not signal a child PID. The supervisor cleans up its own group before exiting; missing confirmation returns `TERMINATION_UNAVAILABLE` and the outcome is unknown. Descendants that create a new session or process group can escape cleanup and retain pipes; pipe draining is bounded. A supervisor crash can leave work running. This is not a sandbox.

Targets include server PID, session ID, window ID and pane ID. Identity is validated against the configured workspace, then evaluated again in tmux's command queue for supported operations. Stale targets fail without falling back to another pane. Reconnect can initially show another window.

## Configuration

Run `npm ci --ignore-scripts` in `mcp/`. A local MCP client's command is an absolute Node executable with the absolute `mcp/server.js` path as its argument. Supply environment values in private configuration:

- `WEB_TERMINAL_TMUX_SERVER`: existing dedicated server name.
- `WEB_TERMINAL_MCP_SESSION`: existing workspace session name.
- `TMUX_BIN`: optional absolute tmux executable.

The workspace must already exist. Use the same OS account as tmux. With no socket setting, transport is stdio. This config connects a local client, not hosted ChatGPT.

For remote clients set `WEB_TERMINAL_MCP_SOCKET` to an absolute socket in an owned mode-0700 directory. Existing socket paths are refused; the new socket is mode 0600. The authenticated gateway forwards POST `/mcp` to this private origin, dropping Origin. Origin-bearing direct requests are denied. The origin has no remote authentication and must never be published directly. The official MCP SDK v1 maintenance line is pinned, using stateless Streamable HTTP JSON responses.

A dedicated launchd user agent should invoke a private wrapper loading an owner-only env file, export the variables above, and exec the pinned Node executable with the released server path. Keep logs private and never log bodies, tokens, terminal text or input. Deploy/restart only the MCP service, preserving ttyd and tmux. Verify the old MCP process stopped before removing a stale socket. Retain the previous release and plist for rollback.

## Verification and limits

`cd mcp && npm test` uses disposable tmux servers only: grouped-view text visibility, key/control rejection, stale PID/removed-pane rejection, grouped selection, SDK stdio handshake/calls, and private HTTP initialize/list with Origin denial. A separate real Chrome/ttyd 1.7.7 isolated fixture switched to another grouped window, then typed a harmless marker; Chrome readback of the actual xterm buffer confirmed the marker was visible after automatic target selection. The owned fixture listener and tmux server were removed. These checks do not prove a real hosted ChatGPT/Claude connector, production browser behavior, simultaneous-input conflict handling or OS lifecycle persistence. No input lock or collaboration cursor is provided. Owner-authorized terminal reads send content to the AI provider.

SDK reference: https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x

## Current connection authorization

The consent page now offers owner-selected authorization duration and a protected connected-app management page. Approved client registrations and grants persist across OAuth gateway restarts; revocation remains explicit. See [the authorization contract](../mcp-auth/README.md) for duration, storage, expiry and migration rules, and [UI verification](consent-ui-verification.md) for browser evidence. Upgrading from the initial in-memory release requires connecting the app again once.

## Initial deployment evidence, 2026-11-05

The owner-authorized Mac deployment adds separate MCP and OAuth user services. The existing terminal, upload service and tmux server remain in place. The terminal URL remains `https://terminal.gmb01.xyz/`; the remote MCP connection URL is `https://terminal-mcp.gmb01.xyz/mcp`. Approval returns to the existing Access-protected terminal hostname. Tunnel configuration and original pane process identities were backed up privately before deployment.

Independent checks passed the existing 30 runtime/client tests, three MCP tests and three OAuth tests. A real Chrome loopback fixture confirmed automatic grouped-view switching and visible typed text in xterm. Public OAuth discovery returned 200, MCP without a bearer returned 401, and terminal/upload/approval routes without browser credentials retained Access redirects. Existing three pane process identities were preserved. A short-read smoke test exposed trailing blank rows hiding text in fresh panes; the implementation and regression now omit those rows before applying the requested line bound.

Actual hosted ChatGPT and Claude account connection still requires the owner's browser sign-in and explicit OAuth consent. Those hosted-client handshakes and authenticated production browser rendering are not established by fixture tests. Grants last one hour, have no refresh token, and are revoked by gateway restart. For rollback, stop only the two added MCP services and restore the privately backed-up tunnel configuration; preserve ttyd and tmux. The added DNS name can remain safely pointed at the restored tunnel's 404 fallback until deliberately removed.

## Background jobs

`terminal_job_start` starts a process outside tmux and returns JSON containing a `job_id` and its initial status. It accepts `executable`, literal `args` (default `[]`), absolute `cwd`, `timeout_ms` (100–3,600,000; default 60,000) and `max_output_bytes` (1–1,048,576; default 262,144). It invokes the executable directly, without a shell, with the server's environment and OS authority. At most four background jobs run concurrently per server process; excess starts return `CONCURRENCY_LIMIT`. This limit is separate from `terminal_exec`'s limit. No additional interactive approval is introduced.

`terminal_job_status` takes `job_id` and returns `status`, `started_at`, `finished_at`, `exit_code`, `signal`, per-stream truncation flags, and a sanitized `error`. States are `starting`, `running`, `success`, `failed`, `error`, `timeout`, `cancelled`, and `interrupted`. `starting` means accepted but not yet confirmed spawned; `started_at` is null until supervisor confirmation. Exit codes come from the operating system and are null when unavailable or the process was signalled. `terminal_job_cancel` takes `job_id`, requests termination through the live supervisor IPC channel and returns the current status. Poll until the supervisor reports a final outcome. If cleanup cannot be verified, it reports `TERMINATION_UNAVAILABLE` and the process may continue. Cancelling an already completed job returns its existing status. Invalid IDs or unavailable jobs return an MCP tool error.

`terminal_job_logs` takes `job_id`, `stream` (`stdout` or `stderr`, default stdout), byte `offset` (default 0), and byte `limit` (1–65,536, default 16,384). It returns `data_base64`, `offset`, `next_offset`, `total_bytes`, and `truncated`. Decode and concatenate bytes before UTF-8 decoding; page boundaries can split a character. Stdout and stderr share the per-job output limit. Further bytes are discarded and the corresponding truncation flag is set, but the process continues until exit, cancellation or timeout. Output is untrusted and may contain sensitive data.

Background job records and bounded output are stored in an owner-only mode-0700 directory (default `~/.web-terminal-jobs`, override with `WEB_TERMINAL_JOB_DIR`). Mode-0600 records contain potentially sensitive output. A verified single-writer registry lock excludes concurrent writers; only verified dead-owner locks can be recovered under a recovery gate. Defaults: logical file-content budget 64 MiB, at most 1,000 recorded jobs, retention window 30 days. Admission may remove only eligible finished records to satisfy limits; running, interrupted or unknown-outcome records are retained. Admission and atomic writes account for lock metadata, old and temporary record content; unknown directory entries fail closed. These are logical byte limits, NOT filesystem block-level physical disk quotas.

**Remaining release risks:** Each POSIX job uses a detached Node supervisor as its session and process-group leader. The controller requests cancellation over its live IPC channel; the supervisor signals only its own group while it is alive, including on controller IPC disconnect. Exit information is sent before final group cleanup, and missing confirmation is reported as an unknown outcome. Recovered interrupted jobs remain unknown and are never killed using a stored PID. A job or descendant that creates a new session or process group can escape cleanup; this is not a sandbox. A supervisor killed independently before cleanup or unable to run can also leave work behind. OS account permissions govern executable access; the registry is not a per-OAuth-client tenant boundary. Independent security review and production release gating are required.


## Optional physical quota and recovery design

The logical content budget is not a physical disk quota. Apple documents [APFS volume quota sizes](https://support.apple.com/guide/disk-utility/dskua9e6a110/mac), not directory quotas. For an opt-in deployment, an administrator should independently provision a dedicated APFS volume with a quota, arrange its mount before service startup, and place the private job directory on it. Confirm the mounted volume identity, quota and available capacity using trusted platform administration tools and account for other writers, snapshots, metadata and filesystem overhead. Test disk-full behavior in a disposable volume, and monitor both the volume and its container. Do not treat a marker file, free-space reading, or logical file count as proof of enforcement. No volume operations are performed by this application.

Set `WEB_TERMINAL_REQUIRE_HARD_QUOTA=1` to fail closed: this version cannot verify APFS volume identity and quota atomically and therefore refuses job-manager initialization even if a volume was manually provisioned. It provides no hard-quota enforcement claim. Atomic replacement needs space for both old and temporary records; ENOSPC can leave the previous record intact and the outcome unknown. Preserve unexpected temporary files for investigation.

After controller loss, a previously running record becomes `interrupted`, with unknown outcome. The current live Node supervisor responds to IPC disconnect by attempting to terminate its own process group, which was validated with a disposable controller-SIGKILL heartbeat test. This is not durable proof that every descendant terminated: a descendant can create another session, the supervisor itself can fail, and the controller cannot reconstruct an atomic OS-owned process handle from stored metadata. Neither a stored PID nor a purported terminal state proves safe identity or completion; recovered records are never automatically deleted, resumed or signalled. Any remaining unknown orphan requires administrator-controlled investigation rather than automatic PID-based cleanup. A stronger future native containment/handle mechanism would be needed for guarantees beyond the supervisor's live process group.


### Storage admission and runtime monitoring

Before `terminal_exec` or `terminal_job_start` spawns a process, a shared server-owned policy samples available bytes (`bsize * bavail`) on the registry and working-directory filesystems. For a registry not yet created, the nearest existing ancestor is sampled; after initialization it is sampled again. The more restrictive state governs admission. Missing paths, invalid metrics, clock errors, stale samples or changed path identity fail closed. Both tools return `error.code` `STORAGE_ADMISSION_DENIED` with a reason state, thresholds and bounded per-location metrics; paths and arguments are omitted. The check does not reserve space.

Defaults are NORMAL at or above 60 GiB, WARNING at or above 40 GiB, CRITICAL at or above 25 GiB, and EMERGENCY below 25 GiB. Only NORMAL admits new executions. `storage_class` is retained as an untrusted compatibility hint and never elevates admission, including when set to `light`.

The server resolves paths and checks device and directory identity after sampling and immediately before spawning; the supervisor checks again before starting an executable. The child uses the sampled canonical working directory. These checks are not atomic: Node's path-based spawn has no dirfd-based chdir sandbox, and an attacker able to change paths or mounts can race the final check. Storage may also change immediately after sampling. This is neither a quota nor filesystem isolation. Existing jobs, other paths and other writers are not constrained.

MCP terminal input follows the server-owned `disabled`, `delegated`, or `coordinated` policy. An approved OAuth client is a delegate, not the owner's identity. Coordinated input uses the shared UI broker and request-bound admissions; caller-supplied owner flags cannot enable input. This is not shell-level confinement; same-account direct OS/tmux access is outside managed arbitration, and the separate full-profile execution tools are not a filesystem sandbox.
Thresholds can be configured as positive, strictly descending integer byte values using `WEB_TERMINAL_STORAGE_NORMAL_BYTES`, `WEB_TERMINAL_STORAGE_WARNING_BYTES`, and `WEB_TERMINAL_STORAGE_CRITICAL_BYTES`. `WEB_TERMINAL_STORAGE_INTERVAL_MS` controls the sampling period (1,000–86,400,000 ms; default 300,000). Invalid configuration fails closed. While jobs run, an unreferenced timer samples their working directories and the registry into bounded memory only. After the first periodic sample, `terminal_job_status` includes `storage_monitor` for a running job; stale or unavailable observations report `UNAVAILABLE`. Monitoring does not cancel jobs or persist periodic samples. Shutdown clears the timer.


### Process-local storage admission and restart retention

Exec and job starts share a process-local per-volume reservation pool. Each admitted execution reserves the configured `WEB_TERMINAL_STORAGE_JOB_BUDGET_BYTES` (default 1 GiB) on each distinct registry and working-directory device, above the normal threshold and `WEB_TERMINAL_STORAGE_MIN_RESERVE_BYTES` (default 1 GiB). Unknown free space fails closed. Reservations remain until the supervisor closes, including while a job is starting. This accounting does not limit spawned process writes, reserve physical blocks, account for other processes, or guarantee free space. Use independently enforced OS isolation and quotas for hard limits.

Recovered records, including records that could have been forged by another process with the same OS identity, are not eligible for automatic retention deletion. The current process only deletes eligible records it finished itself. File permissions and a same-identity lock cannot authenticate record provenance against that identity. A future security architecture would isolate the registry writer under a separate OS identity and protect its storage and signing or verification authority from command processes; recovery and deletion must rely on independently verifiable ownership and a reviewed migration policy. Until that boundary exists, preserve unsigned legacy records and require an authorized operator to investigate capacity pressure. No HMAC is implemented or implied.

### Mobile context editor

Use **Paste context** in the browser toolbar/actions menu. Paste into the editor;
for multiline content create a private temporary text file, then copy or separately
confirm and insert its path. Ask the AI to read the file. Raw multiline content is
never inserted into the terminal. Single-line/path insertion adds no Enter and
pauses managed AI until explicit Resume sharing. Context files expire after one
hour or can be deleted early. See [mobile context paste](mobile-context-paste-plan.md)
for limits, target confirmation, recovery and privacy. After coordinator/UI restart,
AI input starts paused and requires explicit owner Resume sharing.
