# Web Terminal MCP

See [shared terminal setup](../docs/shared-terminal-mcp.md).

Install: `npm ci --ignore-scripts`

Verify: `npm test`

Start with explicit `WEB_TERMINAL_TMUX_SERVER` and `WEB_TERMINAL_MCP_SESSION`: `node server.js`.

Default transport is stdio. `WEB_TERMINAL_MCP_SOCKET` enables private Unix-socket HTTP `/mcp` for an authenticated gateway.

For the Linux tab UI, set `WEB_TERMINAL_MCP_LAYOUT=linux-tabs` and the existing `WEB_TERMINAL_TMUX_SERVER`; no fixed session is needed. Only `shared` and `web-` followed by twelve lowercase hexadecimal digits are exposed. Listings include `sessionName` to identify the browser tab. `terminal_new_window` creates an independent browser-compatible session, with the UI's twenty-session limit. Refresh the browser to discover a new tab. Selecting a pane selects its tmux window; the owner switches browser tabs manually. The default `grouped` layout and its browser-view synchronization remain available for the Mac runtime.
