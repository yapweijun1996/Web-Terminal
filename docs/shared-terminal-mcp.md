# Shared terminal MCP

The MCP server operates the same dedicated tmux workspace as the browser terminal. The owner sees agent text in that same pane. Both can input; coordinate before typing concurrently.

## Tools

- `terminal_list`: list shared windows/panes, bounded names, active state and target identities.
- `terminal_read`: read 1–500 lines. Trailing empty screen rows are omitted before selecting the bounded tail; content whitespace is preserved. Output is untrusted application data and may contain sensitive information.
- `terminal_select`: select a window/pane in every session grouped with the workspace, synchronizing browser views with the agent target.
- `terminal_type`: paste 1–8192 bytes of literal text; reject control characters and line breaks. Automatically shows the target in grouped browser views; does not press Enter.
- `terminal_send_key`: send one allowlisted key. Enter submits input; Ctrl-C interrupts and Ctrl-D can end a shell.
- `terminal_new_window`: add a shared tab/window. Call list to identify it.

Targets include server PID, session ID, window ID and pane ID. Identity is validated against the configured workspace, then evaluated again in tmux's command queue. Stale targets fail without falling back to another pane. Never automatically retry uncertain input. Text and key tools select the target in grouped browser views before input. Reconnect can initially show another window.

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
