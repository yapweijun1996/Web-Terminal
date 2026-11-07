# Mac terminal tab redesign

## Goal and scope
Implement the owner supplied IDE-style reference, preserving all terminal sessions and jobs. Keep the single browser tab strip and mouse-menu repair. No release beyond this Mac service, no Git push.

## Exact behavior
- 38px tab strip; inline small close icon; subtle accent active state, distinct hover/focus/disconnected. Touch targets remain usable.
- Close icon hides a browser-local tab only, never terminates a window. Hidden tabs remain searchable/restorable in the session switcher. End window is a separate explicit action with confirmation, stable identity and last-window protection. Confirm all ends because active-job state is not authoritative.
- Custom display name, pin, unpin, reorder via drag/drop and keyboard/menu Move left/right. Preferences are local to the browser, keyed by tmux server PID and window ID, not numeric index. No tmux rename/reorder/global mutation. Invalid/stale stored values are ignored; report unavailable storage.
- Horizontal scrolling contains 10–30 tabs inside the strip; selected tab scrolls into view. Searchable All windows switcher includes visible/hidden tabs and metadata plus actions. Mobile uses same compact strip and switcher. Menus/dialogs stay inside viewport and scroll internally.
- Show confirmed process basename and connection/availability, never claim job health. No process arguments or terminal content.
- Keep existing toolbar functions available in a compact Workspace tools disclosure separate from strip, preserve upload and existing status details.
- Native Cmd+Tab/Cmd+W/Ctrl+Tab remain OS/browser shortcuts; use Ctrl+Alt+ArrowLeft/Right for tab switching, Ctrl+Alt+W hide, Ctrl+Alt+P switcher. Support Arrow/Home/End on tab focus. Document reserved shortcuts. Never send shortcut bytes into terminal.

## Interpretation policy
Use browser-local preferences for missing persistence scope; e.g. pinning one tab must not modify another client. Reject ambiguous destructive targets; e.g. a replacement at same index cannot inherit End confirmation. Preserve native shortcuts rather than overriding OS/browser controls.

## Acceptance
Actual ttyd/tmux browser fixture at desktop 1440/1280, tablet768, mobile390 and equivalent half-width200% zoom; 30 windows; document and strip geometry; overflow/search top/middle/bottom; hide/restore preserves pane PID and unsent draft; rename/pin/reorder survive reload; close only via End confirmation and reject stale identity; keyboard/focus, disconnected and failed-control recovery; mouse context regression. Build, backend/general suites and no page errors. Compare generated screenshots. Live port needs backup/rollback, exact-current HTML surgery, upload-only restart if backend changed, and original pane/service identity preservation.

## Recorded acceptance
2026-11-06: build and 37 general tests passed; real ttyd/tmux E2E passed with 30 windows and seven viewports, including 640×400 as an equivalent 200% layout check. Targeted final status-collision checks passed. The minimal live Mac port and disposable-window checks passed with all nine preexisting pane identities retained. See TASK.md for scope and limits; actual browser zoom, physical touch and VoiceOver remain unverified.
