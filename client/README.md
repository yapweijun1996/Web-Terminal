# Browser client source

This is a reconstruction of the current Mac browser client for isolated development. The upstream ttyd 1.7.7 `html` source and Yarn lockfile were taken from commit `40e79c706be14029b391f369bee6613c31667abb`; see [UPSTREAM-LICENSE](UPSTREAM-LICENSE). The local custom toolbar, image upload interface, viewport setting, and reconnect behavior have been recovered into editable files. The generated HTML is not checked in.

See the [source inventory](../docs/source-inventory.md) for the provenance, exclusions, and verification limits.

An isolated build of the unmodified upstream source produced the same SHA-256 as the page served by the installed stock ttyd 1.7.7. This establishes its upstream baseline; it does not by itself establish complete parity between the reconstructed custom page and the live custom page.

## Build

The recorded development environment used Node.js 23.10.0 and Corepack with Yarn 3.6.3. From this directory:

```sh
corepack yarn install --immutable --mode=skip-build
corepack yarn inline
```

The output is `dist/inline.html`. The build also copies shared mobile-key, display-control, design-token and status-model sources from `../linux/ui`, so keep that directory in the checkout. The inline page includes the shared tokens and status model. The lockfile fixes the dependency graph; verify a clean install and compare output when changing toolchain versions. Upstream's legacy dependencies emit warnings and require a separate upgrade assessment. From the repository root, run `node --test tests/*.test.js` for the local runtime and macOS upload fixture tests.

## Windows browser clipboard

Ctrl+V is passed to the browser for text or supported image paste. Ctrl+C copies a terminal selection; with no selection it remains the terminal interrupt key. When an application or tmux captures the mouse, hold Shift while dragging to select terminal text. Clipboard image paste saves the image and automatically inserts its path into the captured pane when the terminal stays focused and unchanged. If the target, connection, focus or input changes before insertion, the path remains available for manual insertion. An insertion request already sent can still reach the original pane; an uncertain result is not retried automatically. File-picker and drop uploads retain their explicit insertion step. A saved or inserted path alone does not establish that Codex accepted an attachment.

For tmux mouse selections, the client handles a bounded OSC 52 text copy only after a recent trusted selection drag in a focused page. It attempts to write the selection to the browser clipboard and keeps it briefly for Ctrl+C if automatic copying is blocked. Unsolicited clipboard writes and clipboard reads are ignored. A foreground application that captures the mouse, including the tested Codex CLI, may handle ordinary drags itself; use Shift+drag to select its displayed text.

The keyboard behavior was checked in an isolated Chrome fixture with a simulated Windows platform. The matching one-handler change was separately applied to the Mac deployment's existing HTML; see [deployment evidence](../TASK.md). Native Windows clipboard shortcuts, physical mouse selection, and actual Codex image attachment remain unverified.

## Runtime boundary

The scripts in `../runtime` are an isolated development candidate and require explicit per-host environment values. `serve.sh` requires an owned, private runtime directory and refuses an existing socket instead of removing it. The observed ttyd creates a `0660` socket; the `0700` parent directory prevents other users from traversing to it, and same-user processes remain trusted. Recheck permissions and ACLs on the target host. The scripts are not installed into, or automatically synchronized with, the existing Mac service. Do not expose the writable ttyd socket to untrusted clients: establish and independently verify Cloudflare Access, origin-side token validation, socket permissions, and session preservation before any authorized deployment. Never put live hostnames, identities, credentials, uploads, or logs into this repository.

## Mac workspace tabs

The desktop header is 48px high with the four status indicators inline; below 900px they occupy a separate two-row grid. The IDE-style strip is 42px high (44px for coarse pointers). The interface follows the system light or dark appearance using the shared design tokens; the terminal canvas palette is unchanged. The strip's inline × hides only a browser-local tab, preserving the tmux window, jobs and unsent input. Hiding the active tab selects its next visible neighbor; hiding every tab displays an empty view and an All windows restoration action while the terminal stays attached. The separate End window action always confirms a stable window/view/server identity and protects the last window. Ending affects all panes in that window and its other grouped views; detached processes may continue.

All windows searches display names, indexes and confirmed process basenames across visible and hidden windows. Actions restore, rename, pin/unpin, move and end a window. Drag/drop and Move left/right change local order; crossing the pin boundary adopts the destination pin state. Display names never rename tmux windows. Preferences use server PID plus stable window ID in localStorage, not numeric index; invalid values are ignored and unavailable storage is reported. Process basenames and connection availability are observations, not task-health proof; no command arguments or terminal contents are read.

Workspace tools retains New window, Display, Keys, previous/next, Return to live, Details and Upload image. Cmd+Tab, Cmd+W and Ctrl+Tab remain OS/browser shortcuts. Ctrl+Alt+Left/Right switches visible tabs, Ctrl+Alt+W hides the current tab, and Ctrl+Alt+P opens All windows without sending bytes to the terminal. On a focused tab, Arrow keys, Home and End switch with visible focus.

The status indicators separately report the connection, confirmed active window and process basename, input, and sharing. Details retains the reminder to check the active window after reconnecting. Input and sharing are shown as not reported because this Mac client does not receive those states. A disconnected browser does not establish task health. At widths below 900px, the four indicators occupy two rows; the process detail remains available in the session indicator's accessible description.

A successful browser-list request hides the native status only in that validated browser view. Workspace/global defaults and other views stay unchanged. If the first window-list probe returns 404, 405, or a successful non-JSON body, the client treats window controls as not provided, leaves the native tmux status available, omits the browser tab strip and explains this in Details. A reachable listing failure restores saved native status and hides browser tabs with a warning; a new connection starts with native defaults. Complete control-service unavailability after a successful probe requires recovery or reconnect. Lists above 100 fail closed, hidden pages pause polling, and requests time out after five seconds. TASK.md records live acceptance separately from isolated fixture evidence.

### Right-click menu ownership

When the terminal requests mouse reporting, an ordinary right-click inside the terminal opens only the terminal/application menu: the browser context menu is suppressed without consuming the right-button report. Shift+right-click retains the browser menu, as do touch long-press, clicks outside the terminal, and terminal states without mouse reporting. This avoids overlapping Chrome and tmux menus while retaining native copy/paste access. The isolated browser fixture verifies these event paths and an actual right-button report to tmux. Physical macOS trackpad gesture acceptance is separate.
