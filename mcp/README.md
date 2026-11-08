# Web Terminal MCP

See [shared terminal setup](../docs/shared-terminal-mcp.md).

Install: `npm ci --ignore-scripts`

Verify: `npm test`

Start with explicit `WEB_TERMINAL_TMUX_SERVER` and `WEB_TERMINAL_MCP_SESSION`: `node server.js`.

Default transport is stdio. `WEB_TERMINAL_MCP_SOCKET` enables private Unix-socket HTTP `/mcp` for an authenticated gateway.

For the Linux tab UI, set `WEB_TERMINAL_MCP_LAYOUT=linux-tabs` and the existing `WEB_TERMINAL_TMUX_SERVER`; no fixed session is needed. Only `shared` and `web-` followed by twelve lowercase hexadecimal digits are exposed. Listings include `sessionName` to identify the browser tab. `terminal_new_window` creates an independent browser-compatible session, with the UI's twenty-session limit. Refresh the browser to discover a new tab. Selecting a pane selects its tmux window; the owner switches browser tabs manually. The default `grouped` layout and its browser-view synchronization remain available for the Mac runtime.

For a deployment limited to the six terminal tools, set `WEB_TERMINAL_MCP_TOOLS=terminal-only`.
This profile does not import execution/job modules or initialize a job registry. Its
release may contain just `server.js`, `terminal.js`, `terminal-errors.js`, package
files and dependencies. Tool-set selection never supplies owner authorization. The default `full` profile retains all eleven tools
for existing source deployments. Unknown or empty values fail startup rather than
silently choosing a broader profile. Do not switch a pinned six-tool deployment to
`full` as part of a diagnostic update.


Input is disabled by default. Set `WEB_TERMINAL_MCP_INPUT_MODE=delegated` only
when the operator has enabled owner-approved delegated terminal access. For HTTP,
keep the private Unix socket behind the existing bearer-validating OAuth gateway;
this policy flag is not authentication. For stdio, the launching operator controls
access. Unknown or empty input-mode values fail startup. Tool arguments and client
headers cannot change the mode.

Delegated mode allows literal single-line text and supported keys, with Enter a
separate deliberate action. Input targets the captured pane without selecting or
focusing another view; use `terminal_select` explicitly to navigate. PID, session,
window, pane, Linux-session scope and copy-mode guards still apply. Multiline or
control text is rejected entirely rather than split or submitted automatically.

Overlapping writes to the same target are rejected with `INPUT_BUSY`, and total
in-flight operations are bounded across controller instances in the process.
This coordinates individual MCP operations, not the interval between text and a
later Enter. Human direct ttyd/tmux input and other clients can still interleave;
shared owner-priority arbitration is a separate stage. Never automatically retry
an uncertain mutation, and treat `sent` as dispatch acknowledgement, not command
success. The same-user socket/terminal is not an OS sandbox.
