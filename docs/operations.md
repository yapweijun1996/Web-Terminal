# Operations and verification

These procedures are a checklist, not a deployment recipe. Confirm the target device, account, approved identities, configuration owner, and maintenance window before any service or access change. Never collect credentials, cookies, private terminal contents, or personal file names as routine evidence.

## Before a change

1. Identify the service, its configuration source, origin socket, tunnel and Access policy, session manager, and active job ownership. Record versions and a secret-free baseline.
2. Determine whether the change can disconnect browser clients or affect running jobs. Use a disposable listener and session first; do not send input to an existing user's pane.
3. Record the exact prior configuration and a component-specific rollback plan. Do not replace other tunnels, DNS records, identities, or services.
4. Test changes on the intended platform. User launchd and systemd services depend on their actual user-manager lifecycle; on the observed Linux host, lingering was disabled. Do not assume sessions survive logout, sleep or reboot.

## Acceptance checklist

Record the date, device, versions, test identity, test method, result, and remaining limitations. A configuration inspection is not an end-to-end test.

| Area | Acceptance evidence |
| --- | --- |
| Access | Unauthenticated and unauthorized identities cannot reach terminal HTTP, WebSocket upgrade, or upload routes; an approved identity can. Verify the actual policy and the token audience on every route. |
| Revocation | Test a new connection and an already-open WebSocket separately after session expiry or identity revocation. Do not assume an open connection is terminated automatically. |
| Sessions | In disposable views, run a harmless long-lived job, disconnect and reconnect, and check the same job, history, and unsent input. Reconnection must not submit a command. |
| Shell and TUI | Test shell history, tmux copy mode, a mouse-aware full-screen app, and the installed coding TUI separately. Check first and subsequent wheel gestures, return to latest, keyboard input, and resize. Do not inject keys into an existing user's task. |
| Upload | Test picker, clipboard, and native drag/drop separately; validate rejected types, size and malformed data, interrupted upload, target switching, and retry. Confirm path insertion goes to the original intended target without submitting it. A path is not proof a CLI accepted an attachment. |
| Layout and input | Check desktop and phone-sized viewports, focus, scrolling, visible output, Unicode, and error states. Record actual devices and browsers; a synthetic event is not a physical trackpad test. |
| Workspace and accessibility | Verify active-view identification, keyboard navigation and visible focus; test control labels and connection announcements with documented assistive technology. Closing a view must not silently terminate an unrelated task. |
| Status | Distinguish browser connection, component liveness, and task state; represent unavailable evidence as unknown and do not expose terminal contents or credentials. |
| Recovery | Verify the prior access boundary and job state after an authorized rollback. Record any interruption or incomplete recovery. |

For offline coding-TUI fixtures, independently isolate and verify all network transports before submitting a synthetic prompt. A dummy credential or a changed HTTP base URL does not by itself establish that WebSocket traffic is offline.

The [isolated Access validation plan](isolated-access-validation.md) describes a proposed disposable boundary for the remaining Access, expiry, revocation and connector rollback checks. It does not authorize creation of cloud resources.

## Candidate connection recovery

The repository candidates show connection state independently of background-job state. The Mac candidate pauses terminal input during reconnect, retries with a bounded delay, and offers Retry after recovery fails or sign-in may be required. A new Mac connection can select the workspace's default tmux window rather than the window previously viewed: check the active window and use Previous or Next to return to the intended job before typing. Jobs, drafts and tmux history belong to their respective panes, not to the browser connection. The Linux candidate offers Retry for an unavailable session list or disconnected active view. Retry reconnects the view; it does not submit a command or prove a background job is healthy. If a sign-in message appears, verify access in the browser before retrying. These behaviors were exercised in isolated fixtures. The Mac candidate was subsequently deployed; authenticated browser reconnect and task recovery have not been retested end to end on the deployed version.

The Mac toolbar shows the last tmux-confirmed window and pane; the tmux status line shows window names. On Linux, focus a view button and use the arrow keys, Home or End to navigate. Rename changes only that browser's label. Hide detaches the browser view and keeps its tmux session running; it is not a command to end the task. If browser storage is unavailable, the interface reports that it cannot save a name.

## Candidate image upload

The Mac candidate saves an image and shows its path, the last tmux-confirmed window and pane, and an explicit insertion control. Check that label before inserting: a window switch still in flight has not yet been confirmed. Insertion targets the captured pane, even if another pane is now visible, and sends no Enter. If metadata, the original session, or the pane is unavailable, copy the saved path instead. A path being sent does not establish that a TUI accepted an attachment.

The Linux candidate follows the same confirmation and captured-pane behavior for image paste and drop. It keeps separate result rows for concurrent images. Its ttyd proxy, tmux title settings, receipt service and browser UI are a compatible set; its image and receipt endpoints must all remain behind the verified Access boundary. A disconnected or replaced view requires copying the saved path instead of automatic insertion.

An interrupted HTTP response can be recovered for ten minutes while the same upload service and page remain available. Receipts are in memory and do not survive service restart; the page also loses its receipt reference on reload. Retain or copy a displayed path before leaving the page. If a receipt cannot be obtained, the candidate does not start an upload. The client, ttyd argument validation, tmux configuration, and upload service must be reviewed and deployed as a compatible set. The upload service needs the same dedicated `WEB_TERMINAL_TMUX_SERVER` value as the terminal service for target capture; without it, saving and copying work but pane insertion is unavailable. No live deployment is implied.

## Scroll and display triage

Inspect in order: browser viewport and terminal grid, ttyd/client resize, tmux pane and copy mode, then the foreground application's own alternate-screen and mouse modes. An alternate screen is not proof of mouse capture, and tmux history is not necessarily an application's transcript. Never translate all wheel events into arrow keys: that can alter a command or prompt.

The candidate toolbar reports tmux scrollback or live mode only when it has a current pane identity. Application scroll position remains unknown. **Return to live** asks tmux to leave copy mode in that confirmed pane; it does not send keys to the application or move an application's own transcript. After reconnecting, verify the active pane before using it. A missing or stale pane identity prevents the request.

**Details** shows the current view and browser-observed terminal connection, along with recovery guidance. It does not probe individual components, perform an input/output round trip, determine task health or verify Access authorization; those values are shown as not checked or unknown. The panel displays generic view positions or tmux window and pane numbers, and does not copy commands, terminal output, filenames or credentials into status data. A connected browser socket alone is not proof of end-to-end task health.

The experimental **Keys** bar is collapsed by default. Esc, Tab and arrow buttons send the selected key to the current connected terminal; arrow encoding follows the terminal's reported cursor-key mode and refuses to guess when that mode is unavailable. To send a Ctrl combination, choose a letter and select **Send Ctrl**; the choice clears after it is sent, on disconnect, or if the pane changes. Ctrl+J and Ctrl+M are omitted because they can submit input. The controls do not queue keys while disconnected. Physical touch and soft-keyboard behavior are not yet verified.

The candidate **Display** controls adjust terminal font size and can request increased text contrast using xterm's `minimumContrastRatio`. Settings last for the current page; the Linux UI reapplies them to a newly active terminal view. A setting may be unavailable with a different embedded client. The contrast option is not proof of complete WCAG conformance, and terminal content with a screen reader remains unverified. See the [xterm option reference](https://xtermjs.org/docs/api/terminal/interfaces/iterminaloptions/).

While the terminal input has focus, `Control+Alt+Shift+T` moves focus to the toolbar without sending the shortcut to the terminal. The input's accessible name announces this shortcut. An isolated Orca/Chromium test exercised keyboard navigation and Retry; it did not verify audio output or other assistive technology.

For the recorded ttyd 1.7.7 Mac bundle, historical fixture evidence found that applying line height before font size triggered a final fit and avoided clipping. This observation is version-specific and must be retested after a change or upgrade.

Consult the [lifecycle matrix](lifecycle-matrix.md) before assuming that a session survives a resize, disconnect, restart, sleep, logout or reboot on a given platform.

## Rollback principles

Restore only the exact component changed, using the captured prior configuration. Identify jobs before a restart, logout, removal, or process termination; preserve the tmux server and unrelated tunnels. Verify the restored access boundary and report any lost or unverified behavior. Do not delete retained uploads or other user data as part of routine cleanup; remove only owned disposable test artifacts.
