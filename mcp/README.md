# Web Terminal MCP

See [shared terminal setup](../docs/shared-terminal-mcp.md).

Install: `npm ci --ignore-scripts`

Verify: `npm test`

Start with explicit `WEB_TERMINAL_TMUX_SERVER` and `WEB_TERMINAL_MCP_SESSION`: `node server.js`.

Default transport is stdio. `WEB_TERMINAL_MCP_SOCKET` enables private Unix-socket HTTP `/mcp` for an authenticated gateway.
