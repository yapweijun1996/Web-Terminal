# Module logic reference

Per-module logic, limits and flows, derived from three parallel read-only source scans on 2026-11-19 (MCP server; auth gateway, Windows and collaboration MVP; Linux UI, Mac runtime and client). Constants were spot-checked against source (`MAX_CONCURRENT`, job retention defaults, gateway rate budget, text limit, session limits, reconnect schedule). Everything else is as read from source, not from running services. This is source behavior, not deployment status; see the [features map](features-map.md) for the feature index and [architecture](architecture.md) for trust boundaries.

## 1. Shared terminal MCP (`mcp/`)

### Server and tools (`server.js`)

- Builds `McpServer("web-terminal", "0.1.0")`. Registers six terminal tools, plus five execution tools unless `WEB_TERMINAL_MCP_TOOLS=terminal-only`.
- Tool annotations: `readOnlyHint` for list/read; others `destructiveHint` and `openWorldHint`.
- Input modes (`WEB_TERMINAL_MCP_INPUT_MODE`, default `disabled`; unknown values fail startup):
  - `disabled`: `terminal_type` and `terminal_send_key` fail with `AUTHORITY_UNAVAILABLE`.
  - `delegated`: calls `TerminalController` directly.
  - `coordinated`: routes input and `terminal_list` through `CoordinatedInput` (needs `WEB_TERMINAL_COLLABORATION_SOCKET`).
- Socket mode (`WEB_TERMINAL_MCP_SOCKET`): private parent directory (no group/other bits, not a symlink), socket must not exist, `POST /mcp` only, any `Origin` header gives 403, stateless JSON Streamable HTTP transport per request, socket mode 0600. The `x-web-terminal-admission` header is carried via `AsyncLocalStorage` to the coordinator. Without the variable, transport is stdio.
- Schemas: target `{serverPid, sessionId "$n", windowId "@n", paneId "%n", inputGeneration?}`; `terminal_read` lines 1 to 500 (default 100); `terminal_type` text 1 to 8192; keys limited to Enter, Escape, Tab, BSpace, arrows, C-c, C-d.

### `TerminalController` (`terminal.js`)

- All tmux calls: `tmux -u -L <server> ...` via `execFile`, 5 s timeout. Server and session names match `^[A-Za-z0-9_-]{1,100}$`.
- Every input is guarded: the target is re-listed, then a tmux `if-shell -F` re-checks pid, session, window and pane IDs (and `pane_in_mode==0`) atomically. Output must end with `WT_MCP_OK`, else `STALE_TARGET`.
- `type` uses `set-buffer` and bracketed `paste-buffer`, never submits. `key` uses `send-keys`; only Enter reports `submitted`.
- At most 32 concurrent writes process-wide and one per pane (`INPUT_BUSY`).
- Layouts: `grouped` (Mac, selects across the session group) and `linux-tabs` (sessions `shared` or `web-<12hex>`, 20-session cap).

### Errors (`terminal-errors.js`)

Fixed code/message pairs (`CONTROL_CHAR_OR_MULTILINE`, `COLLABORATION_UNAVAILABLE`, `INPUT_PAUSED`, `STALE_INPUT_GENERATION`, `INPUT_BUSY`, `INVALID_INPUT`, `INVALID_TARGET`, `STALE_TARGET`, `AUTHORITY_UNAVAILABLE`, `OPERATION_UNAVAILABLE`). Any other failure collapses to `OPERATION_UNAVAILABLE`. Text must be non-empty, at most 8192 UTF-8 bytes, without control characters.

### Coordinated input (`coordinated-input.js`)

Requires an absolute, owner-only, non-symlink Unix socket. Calls the coordinator through `privateCall` with a 12 s timeout. `execute` needs a non-empty `inputGeneration` and an admission string (1 to 512 characters) from the request context, and verifies the response (`sent`, `submitted`). Failures become `COLLABORATION_UNAVAILABLE`.

### Execution (`exec.js`, `jobs.js`, `job-supervisor.js`)

- `terminal_exec`: returns a result object and never throws. Timeout 100 ms to 60 s (default 10 s), output cap up to 1 MiB (default 256 KiB, shared across stdout and stderr), at most 4 concurrent executions. Statuses include success, failed, timeout, output_limit, error.
- `terminal_job_start`: same schema with timeout up to 1 h. `JobManager` defaults: 64 MiB total, 1000 jobs, 30 days retention, 4 active jobs.
- A detached `job-supervisor.js` process leads the process group, spawns without a shell, re-checks storage identities, and on stop sends SIGTERM then SIGKILL to the group. Parent disconnect gives `interrupted`.
- Registry: one `<uuid>.json` per job, atomic write (temp, fsync, rename), directory 0700, lock directory with owner pid and stale-lock recovery. Non-terminal records found at startup become `interrupted` (`SERVER_RESTART`).
- `terminal_job_logs` returns base64 data with offset and `next_offset` (limit up to 65536).
- Known gap: `storage_class` is parsed but unused.

### Storage safety (`storage-safety.js`, `storage-reservations.js`)

- Samples free space on both registry and working-directory volumes. Thresholds (env, defaults): normal 60 GiB, warning 40 GiB, critical 25 GiB. Work is admitted only in `NORMAL`; stale samples, clock regression or identity change give `UNAVAILABLE`.
- Reservations are process-local accounting (default job budget 1 GiB, minimum reserve 1 GiB), not a filesystem quota.

### Not wired into production code

`registry-writer-*` (protocol, transport, service, journal) and `restart-retention.js` are candidate or offline-simulation modules. The transport and service always refuse (`TRUSTED_VERIFIER_UNAVAILABLE`); the restart-retention policy always reports unavailable and no automatic deletion. `runtime/gateway/broker.js` (`InputBroker`) is not imported by `mcp/`.

## 2. Input gateway contracts (`runtime/gateway/`)

- `collaboration-contract.cjs`: `operationDigest` is SHA-256 over tool, target identity (including `inputGeneration`) and text or key. `privateCall` posts JSON to a Unix socket, route `^/v1/[a-z-]+$`, bodies at most 1 MiB, status must be 200.
- `broker.js` `InputBroker`: in-process, serialized lease authority; not an authentication boundary. Leases keyed by server pid and pane, TTL 15 s by default (1 ms to 60 s), random 32-byte token, `epoch:generation` counter. `claim` fails while a lease is held unless takeover is permitted. `mutate` re-verifies lease and target before and after execution.

## 3. MCP authorization gateway (`mcp-auth/`)

Three servers on private owner-only sockets: public, approval and grant-verifier.

- **Config**: `MCP_PUBLIC_URL`, `MCP_APPROVAL_URL`, `MCP_REDIRECT_URIS`, `MCP_UPSTREAM_SOCKET`, `MCP_STATE_DIR`, `MCP_STATE_KEY_FILE`, `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, optional `ACCESS_OWNER_EMAIL`, `MCP_GRANT_MAX_SECONDS`, `MCP_REQUEST_BODY_TIMEOUT_MS` (1 to 30000, default 5000), and optional `MCP_COLLABORATION_SOCKET`.
- **Public routes**: host must match the public host; global budget 600 requests per 60 s (429).
  - Metadata: only S256 PKCE, public clients (`none`), scope `terminal`.
  - `/oauth/register`: JSON up to 16 KiB, 1 to 5 redirect URIs, all in the allowlist.
  - `/oauth/authorize`: no repeated parameters, registered redirect, `response_type=code`, S256 challenge, exact `resource`; stores a pending record (CSRF token, 5 min) and redirects to the approval URL.
  - `/oauth/token`: single-use code looked up by digest, verifies client, redirect, resource and PKCE; returns a 43-character bearer with the grant's remaining lifetime. Every failure returns `invalid_request`.
  - `/oauth/revoke`: always 200 for the caller; with collaboration enabled it also revokes at the coordinator (503 if that cannot be confirmed).
  - `/mcp`: bearer checked before and again after reading the body (1 MiB cap, whole-body deadline); for `terminal_type` and `terminal_send_key` an admission is obtained from the coordinator and forwarded as `x-web-terminal-admission`; proxied to the upstream socket with a 15 s timeout; the bearer is not forwarded.
- **Approval surface**: every request needs a valid Cloudflare Access JWT (RS256, issuer, audience, `exp`, `iat`, `sub`, `email`, optional owner email). POSTs require exact approval Origin, form encoding and a CSRF token. Consent offers 1 hour, 1 day, 1 week, 1 month (default) or 1 year; codes live 60 s. A connections page lists and revokes grants.
- **`GrantStore`**: in-memory or persistent. Persistent mode needs private (0700/0600), owned, non-symlink paths and a writer lock. `grants.json` is `{version, payload, mac}` with an HMAC-SHA256 integrity MAC; tokens and codes are stored only as domain-separated HMAC digests. Limits: 100 clients, 1000 grants, 2 MiB file. Any persistence error fails all later calls closed.
- **Memory-only state**: pending requests, unredeemed codes, CSRF tokens and the revocation map are lost on restart; clients and grants persist.

## 4. Windows adapter (`windows/`)

- `access.mjs`: validates config (64-hex audience, port 1024 to 65535) and verifies the Access JWT (RS256, issuer from team name, audience, owner email).
- `server.mjs`: loopback only, win32 only. Every request and upgrade needs Host match and JWT (403 otherwise). Mutations need exact HTTPS Origin, `x-terminal-request` token, empty body. Up to 20 sessions. WebSocket `/ws/<uuid>`: subprotocol `terminal,<token>`, at most 4 clients per session, 64 KiB payload, `input` (at most 16384 characters) and `resize` (cols 10 to 500, rows 2 to 200) only; closes with 4001 at JWT expiry.
- `sessions.mjs` and `pty-worker.mjs`: one forked worker per shell using node-pty/ConPTY (100x30) and a headless xterm with 5000 lines of scrollback. Backpressure pauses the child above 4 MiB pending and resumes below 1 MiB. Sessions live in memory only.
- `public/app.js`: up to 5 reconnects with backoff capped at 15 s; hidden views kept in `localStorage`.

## 5. Linux UI (`linux/ui/`)

- **Runtime**: Unix socket `<runtime>/ui.sock` (0600; refuses an existing path), runtime directory must be owned and 0700. One ttyd per tmux session on `ttyd-<name>.sock` (`attach-tab.sh` runs `tmux new-session -A`). Session names match `^(shared|web-[a-f0-9]{12})$`; at most 20 sessions.
- **Mutation guard**: exact Origin, per-process `X-Terminal-Request` token, JSON content type. Tab close and split are applied atomically through `tmux if-shell` against session id and server pid; splits are capped at 4 panes.
- **ttyd proxy**: strips cookie and Access JWT headers, injects a shim that posts connection state and the pane target to the parent page, and blocks stdin unless connected. WebSocket upgrades require matching Origin.
- **Images**: prepare, upload, insert via one-shot receipts (48-hex, 10 min, at most 100). Upload accepts octet-stream up to 10 MiB with PNG/JPEG/WebP magic checks, 3 concurrent, storage cap 500 files or 500 MiB; stored as `<32hex>.<ext>` mode 0600.
- **Context paste** (collaboration only): 64 KiB text files (`<48hex>.txt`, 1 h TTL), single-line insert up to 8192 bytes, re-verifies pane and attached clients before dispatch and never retries an attempted insert. Insert goes through `coordinator.human()` and pauses AI input.
- **Collaboration** (`collaboration.js`, `-websocket.js`, `-controls.js`, `-telemetry.js`): coordinator on a private socket (`/v1/admit`, `/execute`, `/list`, `/revoke`). New sessions start paused (fail closed). Human idle default 10 s; states unknown, manual-paused, pause-pending, owner-active, paused, sharing. Actions: pause, takeover, resume (refused while human input is pending). The managed WebSocket routes input frames through the coordinator and closes on unknown frame types. Telemetry is fixed-schema, rate-limited, and written only to non-blocking sockets or FIFOs.
- **Page logic**: `status-model.js` derives four indicators (connection, session, input, sharing); `sidebar.js` handles width 200 to 320, theme, pinning, search and status; `clipboard-bridge.js` extracts OSC 52 (limit 1.4M characters) from ttyd frames; `mobile-keys.js` excludes Ctrl+J and Ctrl+M; `touch-scroll.js` converts one-finger scrolling to wheel events or scroll lines; `display-controls.js` offers page-local font size 10 to 30 and a contrast toggle.

## 6. Mac runtime and client (`runtime/`, `client/src/`)

- **Runtime**: `serve.sh` starts ttyd on a private socket (refuses an existing socket) with origin checking and URL arguments. `attach.sh` creates a grouped tmux session `view-<uuid>-<pid>` per browser view (UUID v4 validated) and cleans it up on exit. `tmux.conf` sets mouse and a copy-mode wheel binding.
- **`upload-server.js`** (macOS only, uses `sips`): single route `POST /__terminal_upload`, Origin must equal the allowed origin. Control actions via `X-Terminal-Action` (`capture`, `insert`, `insert-current`, `result`, `latest`, `windows`, `select-window`, `close-window`, `native-tabs`); upload accepts PNG/JPEG/GIF/WebP up to 10 MB, verified with `sips` (at most 40 megapixels), at most 4 concurrent.
- **`upload-target.js`**: tickets (48-hex, 10 min, at most 100) bind an upload to an identified pane. `windows` actions use `if-shell` guards on pid, session and window; close requires more than one window. Insert is one-shot.
- **`connection-lifecycle.js`**: states `idle`, `connecting`, `connected`, `reconnecting`, `offline`, `auth-required`. Reconnect delay `min(1000 * 2^(n-1), 15000)` ms; after more than 6 attempts the state is `offline` and a manual retry is required. Input is disabled except while connected.
- **xterm layer**: ttyd protocol (input `0`, resize `1`, pause `2`, resume `3`), token fetch with 10 s abort, parses the `__WEB_TERMINAL_TARGET__` title and accepts it only for this view. OSC 52 is accepted only within 1.5 s after a user drag; decoded size at most 1 MiB. ZMODEM/trzsz transfers disable stdin while active.
- **`window-tabs.js`**: polls the `windows` action every 2 s; tab preferences (name up to 80 characters, hidden, pinned, order) are stored in `localStorage` per server pid and never rename or end tmux jobs; shortcuts Ctrl+Alt+Left/Right/P/W.
- **`toolbar.js`**: new, previous and next tab buttons send tmux prefix keys; "Return to live" posts the `latest` action.

## Open points found during the scan

- `/oauth/token` returns `invalid_request` for every failure, where standard OAuth would use `invalid_grant` for bad codes.
- `terminal_job_start`'s `storage_class` is accepted and ignored.
- `runtime/tmux.conf` appears to apply only to the Mac path; `linux/ui/attach-tab.sh` does not load it.
- Resolved: `window.webTerminalViewId` is set in `client/src/components/app.tsx` to a fresh `crypto.randomUUID()` per page load (empty string if unavailable, in which case uploads are saved but not auto-inserted).
- Windows CSRF token is process-wide; identity is enforced by the Access JWT.
- `consent-ui.mjs`'s `styleCspHeaders` export is used only by `consent-ui.test.mjs` and `consent-fixture.mjs`; `server.mjs` builds its own CSP, so tests and the live gateway do not share one header definition.
