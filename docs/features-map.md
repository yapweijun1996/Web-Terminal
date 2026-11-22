# Features map

Map of what the repository source implements, by component. It was derived from a source scan on 2026-11-19 (entry points, routes, tool registrations, tests). It describes source, not deployment: the Linux and Mac services are deployed separately and may differ from this tree. See [architecture](architecture.md) and the [MCP connection runbook](mcp-connection-runbook.md) for deployment and trust boundaries. Detailed per-module logic, limits and open points are in [modules-logic.md](modules-logic.md).

## Components at a glance

| Component | Path | Role | Tests |
| --- | --- | --- | --- |
| Mac client | `client/` | ttyd 1.7.7-based web client (TypeScript/Preact) plus toolbar, upload UI, window tabs, connection lifecycle | `tests/*.test.js`, `tests/browser/` |
| Mac runtime | `runtime/` | tmux config, attach/serve scripts, image upload service, input broker | `tests/` |
| Linux UI | `linux/ui/` | Node HTTP/WS server, multi-tab UI, sidebar, mobile keys, context paste | `linux/test/` |
| AI Coding Workspace | `linux/workspace/`, `linux/workspace-ui/` | Optional chat-first page driving Claude Code or Codex CLI in admin-defined Project Roots, with approvals, session history and an optional Terminal panel; off unless configured. See [usage](coding-workspace-usage.md) and [spec](coding-workspace-spec.md) | `linux/test/workspace-*.test.js`, `linux/test/*-adapter.test.js`, `linux/workspace-ui/test/` |
| Shared terminal MCP | `mcp/` | MCP server controlling the shared tmux terminal (stdio or private Unix-socket HTTP) | `mcp/test/` |
| MCP auth gateway | `mcp-auth/` | OAuth 2.x gateway with Cloudflare Access-verified consent in front of `/mcp` | `mcp-auth/*.test.mjs`, `mcp-auth/browser/` |
| Windows adapter | `windows/` | ConPTY shells, Access-JWT-protected HTTP/WS | `windows/test/` |
| Collaboration MVP | `collaboration-mvp/` | Local experimental multi-viewer, single-writer-lease demo | `tests/collaboration-mvp.test.js` |

## Request path

```text
Browser -> Cloudflare Access + Tunnel -> ttyd / Linux UI / Windows server -> tmux (or ConPTY)
MCP client -> Tunnel (MCP hostname) -> mcp-auth (OAuth, bearer) -> private socket -> mcp server -> tmux
```

The Linux UI and MCP gateway do not replace Access; they require a private origin socket behind it.

## Browser terminal features

| Feature | Platform | Source | Notes |
| --- | --- | --- | --- |
| Terminal rendering (xterm) | Mac | `client/src/components/terminal/xterm/index.ts`, `.../addons/overlay.ts` | Upstream ttyd client with local viewport/reconnect customizations |
| Connection lifecycle states and reconnect | Mac | `client/src/connection-lifecycle.js` | `tests/connection-lifecycle.test.js` |
| Window tabs (create/select/hide/restore/rename/end/reorder, visible "+" button) | Mac | `client/src/window-tabs.js` | Preferences never rename or end tmux jobs; spec in [mac-tabs-redesign-spec](mac-tabs-redesign-spec.md) |
| Toolbar | Mac | `client/src/toolbar.js`, `toolbar.css` | |
| Image upload, pane-bound receipt | Mac | `client/src/upload.js`, `runtime/upload-server.js`, `runtime/upload-target.js` | Concurrency slot held until completion; receipt bound to an identified tmux pane |
| ZMODEM file transfer | Mac | `.../addons/zmodem.ts`, `client/.yarn/patches/` | |
| Clipboard: shortcuts, OSC 52 | Mac | `.../clipboard-shortcuts.ts`, `.../osc52-clipboard.ts` | `tests/osc52-clipboard.test.js`; Windows has `tests/windows-clipboard-shortcuts.test.js` |
| Independent tabs (up to 20 sessions), pane split (with pane limit) | Linux | `linux/ui/server.js` (`/api/sessions`), `attach-tab.sh` | One ttyd per tab on a private socket; new tabs start in `TERMINAL_START_DIR` |
| Sidebar navigation | Linux | `linux/ui/sidebar.js`, `sidebar.css` | `linux/test/sidebar*.test.js` |
| Four-indicator status bar | Linux, Mac | `linux/ui/status-model.js`, `tests/status-model.test.js` | |
| Display controls | Linux | `linux/ui/display-controls.*` | |
| Mobile keys and touch scrolling | Linux | `linux/ui/mobile-keys.*`, `touch-scroll.js` | Browser e2e: `tests/browser/linux-mobile-keyboard.e2e.cjs`, `touch-scroll.e2e.cjs` |
| Clipboard bridge | Linux | `linux/ui/clipboard-bridge.js` | |
| Image upload with receipts (500 files / 500 MB cap) | Linux | `linux/ui/image-receipts.js`, `/api/images*` | `linux/test/image-ui.test.js` |
| Mobile context paste (prepare/file/insert/delete) | Linux | `linux/ui/context-paste*.js`, `/api/context/*` | Requires the collaboration socket; plan in [mobile-context-paste-plan](mobile-context-paste-plan.md) |
| Collaboration state and control | Linux | `linux/ui/collaboration*.js`, `/api/collaboration/state`, `/api/collaboration/control` | Owner verifier, controls, telemetry, WebSocket |
| Native ConPTY shells (max 20, hide/restore/reconnect/end, 5,000-line history) | Windows | `windows/server.mjs`, `sessions.mjs`, `pty-worker.mjs`, `public/` | `GET/POST /api/sessions`; Origin and request token on mutations |
| Cloudflare Access JWT verification | Windows | `windows/access.mjs` | No dev bypass; WebSocket closes at JWT expiry |

## Shared terminal MCP (`mcp/`)

Transport: stdio by default; private Unix-socket HTTP `/mcp` when `WEB_TERMINAL_MCP_SOCKET` is set.

| Tool | Purpose | Notes |
| --- | --- | --- |
| `terminal_list` | List windows/panes (with `sessionName` in `linux-tabs` layout) | Read-only |
| `terminal_read` | Read pane contents | Read-only |
| `terminal_type` | Type text into a pane | Needs `WEB_TERMINAL_MCP_INPUT_MODE=delegated` |
| `terminal_send_key` | Send a key | Same input gate |
| `terminal_select` | Select a window/pane | Linux tabs: browser tab switched manually by owner |
| `terminal_new_window` | Create a window or browser-compatible session | 20-session UI limit |
| `terminal_exec` | Run a command | `mcp/exec.js`; full profile only |
| `terminal_job_start` / `_status` / `_logs` / `_cancel` | Background jobs | `mcp/jobs.js`, `job-supervisor.js` |

Profiles and options: `WEB_TERMINAL_MCP_TOOLS=terminal-only` (six terminal tools, no job registry) or `full` (default, eleven tools); `WEB_TERMINAL_MCP_LAYOUT=linux-tabs` or default `grouped`. Unknown values fail startup.

Supporting modules:

| Module | Role |
| --- | --- |
| `terminal.js`, `terminal-errors.js` | `TerminalController`; target snapshots, pane PID and dispatch checks; typed errors |
| `coordinated-input.js` | Human/MCP input coordination and owner takeover |
| `jobs.js`, `job-supervisor.js` | `JobManager`; job lifecycle and supervision |
| `storage-safety.js`, `storage-reservations.js` | Path identity checks and physical storage reservations |
| `registry-writer-*.js` | Registry writer journal, protocol, transport, service |
| `restart-retention.js` | Retention across service restart ([boundary](restart-retention-boundary.md)) |
| `native/peercred_probe.c` | Peer-credential probe for the Unix socket ([proof](native-peercred-proof.md)) |

## MCP authorization gateway (`mcp-auth/`)

| Endpoint | Purpose |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` and resource metadata | OAuth discovery |
| `POST /oauth/register` | Dynamic client registration (exact redirect allowlist) |
| `GET /oauth/authorize` | Redirect to Access-protected approval; consent form |
| `POST /oauth/token` | Code exchange (PKCE S256, resource-bound; no refresh tokens) |
| `POST /oauth/revoke` | Immediate bearer revocation |
| `/mcp` | Bearer-checked proxy to the private MCP socket (re-checked before upstream connect) |

Policy and storage: `grant-policy.mjs` (1 hour, 1 day, 1 week, 1 month default, 1 year; `MCP_GRANT_MAX_SECONDS` cap; 60 s code TTL), `grant-store.mjs` (HMAC-digested tokens, absolute expiry, persistence), `consent-ui.mjs` (named client and callback, same-origin POST with nonce). Verification requirements: [consent verification](consent-ui-verification.md).

## Input collaboration

- `runtime/gateway/broker.js` (`InputBroker`): in-process serialized input authority with connections, writer leases (TTL up to 60 s), takeover and generation tracking. Not an authentication boundary.
- `runtime/gateway/collaboration-contract.cjs`: operation digest over target and text/key, plus bounded private-socket calls (`/v1/*`, 1 MiB cap).
- `collaboration-mvp/`: local demo with two viewers, claimable writer lease, observer denial and 15 s lease expiry. Not production.

## Cross-cutting guarantees

- Browser tab preferences and disconnects never end tmux jobs.
- Existing sockets are refused, not replaced; graceful stop removes owned sockets.
- Diagnostic logs exclude query strings, bodies, headers, tokens, OAuth codes, cookies and terminal contents.
- Source in this repository does not authorize deployment, restart, or exposure of another machine.

## Where to verify

| Area | Command |
| --- | --- |
| Mac client/runtime | `node --test tests/*.test.js` (repository root) |
| Linux UI | `cd linux && npm test` |
| MCP | `cd mcp && npm test` |
| Auth gateway | `cd mcp-auth && npm test` |
| Windows | `cd windows && npm test` |
| Browser e2e | `tests/browser/`, `linux/test/*.e2e.*`, `mcp-auth/browser/` |

Passing tests do not establish live deployment status or hosted-client acceptance; see the runbook.
