# Mac UI redesign: live HTML port notes

This describes the repository candidate, not a deployment or a claim about the currently served HTML. Do not deploy without separate authorization. The live Mac HTML may differ from the rebuilt candidate: inspect the exact served artifact and preserve a recoverable, byte-exact backup before preparing any port. Do not replace it wholesale with `client/dist/inline.html` or restart the terminal, tmux, or a tunnel merely to change the UI.

## Candidate pieces

- Inline the shared `linux/ui/tokens.css` before the custom toolbar, mobile-key, display-control, and upload styles. `client/src/toolbar.css` reserves the toolbar, tab, mobile-key and status heights in `#terminal-container`, adjusts terminal padding, and styles the compact workspace chrome. At desktop widths the 48px header contains the title and four status indicators; below 900px the indicators occupy a separate two-row grid. New window is in Workspace tools. Preserve existing selectors and the terminal canvas palette.
- Inline the unchanged shared `linux/ui/status-model.js` before `toolbar.js`. The candidate `client/src/toolbar.js` creates and updates `#workspace-status`; it maps the existing connection lifecycle into model states and shows input and sharing as not reported. It applies the system light/dark preference to the chrome tokens without changing the terminal canvas palette. The candidate `client/src/window-tabs.js` supplies only the confirmed active window name and process basename, invalidates stale observations when the target or connection changes, and retains browser-local tab behavior. If the first list probe returns 404, 405 or a successful non-JSON body, it leaves the native tmux status available and reports missing controls only in Details; later control failures keep the warning and native fallback. Preserve existing toolbar and tab IDs, handlers, upload integration, right-click ownership, connection lifecycle, and compiled terminal bundle.
- `client/src/template.html` and `client/webpack.config.js` only arrange/copy the shared assets for the candidate build; they are not standalone changes to a served inline page. Port the corresponding CSS and script blocks in dependency order, reconciling each with the exact live artifact rather than assuming its structure or contents match this checkout. No backend protocol change is part of this candidate.

The follow-up candidate places `#window-tabs-status` in the toolbar flex flow with ellipsis and preserves its live-region semantics. The tools panel starts below the status rows and tab strip; New window is hidden if the control endpoint is absent. The toolbar focus shortcut targets the disclosure when its New window button is hidden or the panel is closed. Keep these changes together when preparing a separately authorized port.

The isolated built-page Chromium fixture checks header intersection, viewport and ancestor clipping, center hit-testing, and text size at nine widths in both themes, with present/absent controls, long status, and an open tools panel. Injecting the previous fixed status CSS triggers the geometry regression. Captures reviewed in `/private/tmp/omp-shots/final4/` do not establish live-client or physical-device acceptance.

## Linux live-deploy requirement

The Linux candidate adds explicit `tokens.css` and `status-model.js` routes to
`linux/ui/server.js`. The Linux UI process **must be restarted** to load that
allowlist before it can serve the new status bar assets; replacing static files
alone is insufficient. This is not the earlier static-only keyboard port.
Restart only with separate authorization, after checking the target host,
service path, session retention, backups and rollback. This checkout has not
been deployed.

Before any separately authorized live change, review the exact diff and rollback procedure, record existing pane and service identities, and run the native and cross-origin checks applicable to any authorization changes. Validate the real page's controls, connection states, viewport sizes, focus, resize and existing pane identities after a permitted change. Isolated fixture results do not establish live-client acceptance.
