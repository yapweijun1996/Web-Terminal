# Improvement roadmap and research

Snapshot: 2026-11-04. This is a prioritized proposal based on read-only source inspection, the recorded Skill evidence, and vendor documentation. It is not a claim that the proposed changes are implemented or that an untested risk is a confirmed defect.

The [task backlog](../TASK.md) owns priorities, statuses, scope, and acceptance checks. It covers access verification, reproducible source, Codex scrolling, reconnect and workspace UX, upload safety, accessibility, mobile input, diagnostics, lifecycle testing, and dependency assessment. A disposable fixture confirmed that switching windows during upload could insert the path in the wrong pane; the candidate now binds the last confirmed pane and requires explicit insertion. The interrupted-processing limit was also reproduced and corrected. Neither change is deployed to the live service.

## Research notes

- Cloudflare documents Access JWT validation at the origin and cloudflared origin Access settings. Validate signature, issuer, expiry, and the intended audience; a header's presence alone is not authentication. Review each configured route and installed-version behavior. [JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) · [Tunnel origin parameters](https://developers.cloudflare.com/tunnel/reference/origin-parameters/)
- Cloudflare documents that WebSockets can disconnect during network events or after idle periods. Reconnection and session restoration therefore need separate tests; an existing connection's revocation behavior must not be inferred from a new-login test. [WebSockets](https://developers.cloudflare.com/network/websockets/) · [Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- tmux documents mouse and scrollback behavior and provides examples of different mouse bindings. Shell scrollback, copy mode, and an application's own mouse handling must be tested separately. [tmux FAQ](https://github.com/tmux/tmux/wiki/FAQ) · [tmux recipes](https://github.com/tmux/tmux/wiki/Recipes)
- ttyd supports terminal interaction and resize through its server and protocol; those features alone do not authenticate the visitor or prove that every TUI handles scrolling correctly. [ttyd server](https://github.com/tsl0922/ttyd/blob/main/src/server.c) · [ttyd protocol](https://github.com/tsl0922/ttyd/blob/main/src/protocol.c)
- Compare browser terminal dimensions with the PTY after resize; a client fit alone does not establish that both ends agree. [xterm.js terminal API](https://xtermjs.org/docs/api/terminal/classes/terminal/) · [Fit addon API](https://github.com/xtermjs/xterm.js/blob/master/addons/addon-fit/typings/addon-fit.d.ts)

## Suggested sequence

First establish access evidence and a clean, secret-free source and build workflow. Reproduce the Codex and upload scenarios in disposable fixtures before changing behavior. Any live change needs a scoped rollback and verification of existing sessions. See [TASK.md](../TASK.md) for the maintained working order.
