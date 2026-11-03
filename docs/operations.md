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

## Scroll and display triage

Inspect in order: browser viewport and terminal grid, ttyd/client resize, tmux pane and copy mode, then the foreground application's own alternate-screen and mouse modes. An alternate screen is not proof of mouse capture, and tmux history is not necessarily an application's transcript. Never translate all wheel events into arrow keys: that can alter a command or prompt.

For the recorded ttyd 1.7.7 Mac bundle, historical fixture evidence found that applying line height before font size triggered a final fit and avoided clipping. This observation is version-specific and must be retested after a change or upgrade.

## Rollback principles

Restore only the exact component changed, using the captured prior configuration. Identify jobs before a restart, logout, removal, or process termination; preserve the tmux server and unrelated tunnels. Verify the restored access boundary and report any lost or unverified behavior. Do not delete retained uploads or other user data as part of routine cleanup; remove only owned disposable test artifacts.
