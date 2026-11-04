# Linux implementation snapshot

On 2026-11-04, the owner-operated Ubuntu 24.04 ARM64 host had a working Linux terminal deployment separate from the Mac implementation. The files under `linux/` are a source snapshot copied from that host; importing them does not deploy them or make this repository the live source of truth. Inspect the host and preserve existing jobs before making changes.

## Source inventory

| Source | Responsibility |
| --- | --- |
| `linux/ui/server.js` | Private Unix-socket UI, per-session ttyd processes, HTTP/WebSocket proxy and session operations. |
| `linux/ui/image-receipts.js` | Short-lived image receipts and explicit, pane-bound insertion for the development candidate. |
| `linux/ui/index.html`, `app.js`, `style.css` | Browser tab controls, connection indication, hide/restore and return-to-latest control. |
| `linux/ui/attach-tab.sh` | Attach a ttyd client to the corresponding persistent tmux session. |
| `linux/legacy-attach.sh` | Earlier grouped-session attachment used by the existing terminal service. |
| `linux/test/` | Disposable server, ttyd and tmux integration fixture and browser-control unit checks; no live sessions or Cloudflare settings. |

The server obtains ttyd's embedded terminal client at runtime and adds a small connection-status hook. The embedded client is not vendored here. The snapshot expects `tmux` on `PATH` and ttyd at `/usr/bin/ttyd`; it has no npm dependencies or build step. Observed host versions were Node.js 22.23.3, ttyd 1.7.4, tmux 3.4 and cloudflared 2026.10.0. These versions are observations, not pinned dependencies or compatibility guarantees.

## Session and scroll behavior

The UI lists the existing shared session and its own named sessions. Each new tab creates a distinct tmux session. View names can be changed in the browser and are stored locally; they do not rename the tmux session or synchronize to another browser. Use the arrow keys, Home or End while a view button is focused to switch views. Hiding a tab detaches its view without killing the session; Restore tabs makes hidden tabs visible in that browser. Session state is managed by tmux, while hidden-tab preferences are browser-local. The proxy enables tmux mouse mode for a session. The scroll indicator reports tmux mode when a current pane identity is available; application scroll remains unknown. Return to live exits tmux copy mode in the validated pane without sending application input or asserting that an application's transcript is at the end.

The tab × opens a confirmation dialog. Cancel or × leaves the session running; Hide instead preserves the previous hide-and-restore behavior. End session stops all windows in the selected tmux session and terminates its UI-managed ttyd process. The dialog captures the session ID and tmux server PID, and the server checks them before ending it; an unavailable or replaced session must be refreshed and confirmed again. Detached processes may outlive a session.

On 2026-11-04, the owner authorized deployment of this feature. It was ported to the existing Linux UI without deploying the other repository candidate changes. An isolated Chromium/tmux fixture checked cancel, hide, restore, close and replacement-session rejection; after deployment the local UI and a disposable session's close endpoint responded successfully, and the previously recorded pane process IDs remained present. The UI service stop unexpectedly cascaded to the user tunnel; the operation was cancelled but the tunnel stopped. Public access and authenticated browser behavior were not verified as part of these checks.

The candidate displays connection state on desktop and narrow screens. When the session list or terminal connection fails, Retry reloads the session list or reconnects the active view to the same session; it does not create a session or submit input. A sign-in message is tentative because a failed connection can have other causes. Connection status does not report background-job health.

The candidate attempts to give the embedded terminal a generic page title so ttyd's normal title assignments do not announce internal target metadata or the launch command. This worked in the isolated Chromium check; if a browser rejects the override, terminal operation continues and title privacy is not established. The parent iframe keeps its browser-local view label. This is an accessibility and privacy measure, not an access-control boundary.

## Security boundary

The UI and ttyd do **not** independently authenticate the browser or verify a Cloudflare Access JWT. The observed deployment places an Access-protected Cloudflare Tunnel in front of the private UI socket and configures cloudflared to require JWT validation for the application audience on the ingress route. The UI checks origin and a per-process request token for session mutations and checks WebSocket origin; these checks are not a replacement for Access authentication. Terminal execution has the full permissions of its OS user, and processes under that same user can access the private socket.

`TERMINAL_TEST_HTTP=1` is only for a disposable local test fixture. Never use it on a live service. Private hostnames, Access settings, application audience, account details, credentials, logs, terminal output, uploads and user session data are deliberately not included in this repository. The snapshot is not an installer or production deployment recipe.

The Linux candidate requires an absolute, owner-only runtime directory owned by the service user. It refuses to start if `ui.sock` already exists, preserving any existing listener or file. A graceful shutdown removes the socket. After an unclean shutdown, the owner must verify that no service still uses the path and assess the existing entry before removing a stale socket and restarting; do not remove an unknown file or an active service socket. These checks do not authenticate same-user processes or replace Cloudflare Access.

## Verification and limits

From the repository root on Linux with Node.js, tmux and `/usr/bin/ttyd` installed:

```sh
node --test linux/test/*.test.js
```

The test starts a dedicated disposable tmux server and private sockets, tests session creation and origin rejection, checks a ttyd WebSocket upgrade, and verifies a fixture job survives UI restart. It cleans up only the fixture it creates. It does not test Cloudflare Access or the live deployment.

For a repeatable ARM64 Linux fixture, build `linux/test/Dockerfile` using `linux/` as the Docker build context and run the resulting image. The Dockerfile pins the Node base image by digest, the added Alpine package versions, and the reviewed tmux and ttyd binary hashes. It runs the test as an unprivileged user. Package availability still depends on the upstream registry, and the Alpine fixture is not a substitute for testing the Ubuntu deployment; its ttyd and tmux versions differ from those observed on that host.

```sh
docker build --platform linux/arm64 -f linux/test/Dockerfile -t web-terminal-linux-test linux
docker run --rm web-terminal-linux-test
```

On 2026-11-04, the pinned ARM64 Alpine fixture passed the integration test with Node.js 22.23.4, ttyd 1.7.7, and tmux 3.7c. The test ran with networking disabled after the image build. This evidence covers the fixture only.

During the 2026-11-04 implementation, an isolated Chromium fixture separately exercised tab creation and switching, hide and restore, reload, wheel scrollback, Latest, `less --mouse`, a job surviving UI restart, and a phone-sized layout. The original live pane process survived the authorized tunnel restart. Unauthenticated requests to the deployed page, session API and terminal WebSocket path were redirected to Access. The owner displayed an email-restricted Allow policy, but the policy was not independently queried through Cloudflare's management API.

Authenticated production-browser behavior, denial for an unauthorized identity, existing WebSocket expiry/revocation, physical trackpad and mobile touch, and survival across sleep, logout or reboot were not established by those checks. User-manager lingering was disabled at the observation time.

## Browser clipboard and image transfer

The Linux UI handles Ctrl+V in the browser before it reaches terminal applications. PNG, JPEG and WebP files can be pasted or dropped into a terminal view. The candidate saves each file and displays its path and last tmux-confirmed window and pane. After the user checks the target, an explicit control can insert the path into that captured pane without sending Enter; switching to another pane cannot redirect it. If the view or target is unavailable, copy the retained path instead. A path sent to a pane is not proof that an application accepted an image attachment.

For copying text, the UI receives tmux OSC 52 copy requests from the active terminal. A recent pointer or copy-key gesture allows it to write to the browser clipboard; otherwise it offers a Copy selection button. Browser clipboard permissions and focus can prevent automatic copying. Clipboard contents are held in the page while awaiting a copy action and are not logged or stored on the server by this bridge.

### Pi selection and clipboard candidate

The repository candidate enables tmux's server-level `set-clipboard on` when it starts a terminal view and sets `PI_CLIPBOARD_OSC52=1` in sessions created by the UI. Pi's fullscreen text selection can then send its copy request through tmux and ttyd to the browser bridge. This option applies to **every session on the same tmux server**: applications can create tmux clipboard buffers and send clipboard requests to attached clients. An isolated two-client tmux test confirmed that both attached clients received an application OSC 52 sequence. The browser's recent-gesture check is not application identity verification or an isolation boundary; a client without a recent gesture may still receive the text and offer a manual copy. Multiple clients and other applications on the same server must be considered before deployment. Pi may also try to write the host desktop clipboard before emitting OSC 52.

The environment change applies to new UI-created sessions and their new child processes. It does not alter an already-running shell or Pi process, including the existing shared session. After preserving any active work, Pi started from an existing shell needs the variable in its own environment, for example `PI_CLIPBOARD_OSC52=1 pi`. Reconnecting the browser alone does not update an existing process. Pi's OSC 52 implementation has its own encoded-size limit and browser permissions may still require the manual Copy selection button.

On 2026-11-04, only the Pi clipboard changes were deployed to the existing Linux UI version; the other repository candidate changes were not deployed as part of that update. The UI and terminal endpoints returned HTTP 200 on the private socket, `set-clipboard` was `on`, and all 15 previously recorded tmux panes retained their process IDs. This does not establish authenticated production-browser behavior or update already-running Pi processes. The isolated end-to-end fixture uses the installed Pi, ttyd and tmux and a separate headless Chrome profile, with no model calls and a stubbed host clipboard command. With those prerequisites and Node.js 22 or later, run:

```sh
node linux/test/pi-browser.e2e.mjs
```

`PI_BIN` and `CHROME_BIN` can select different executables. The fixture checks visible selection attributes and the test browser's clipboard; it does not establish the original user's browser or existing Pi session is fixed. Its Chrome process is launched without the Chromium sandbox for the local fixture, so run it only in a trusted test environment.

For rollback after an authorized deployment, restore the previous UI implementation first, then restore the previous tmux `set-clipboard` server option. The candidate sets the option again when it starts a view, so changing only the tmux option while leaving the candidate active is not a durable rollback. Do not stop the tmux server or existing jobs to roll back; already-running processes retain the environment with which they started.

Images are retained until the owner removes them. Requests require the same origin and per-process mutation token as session changes, and the tunnel must validate Access for the image and receipt routes. A receipt can recover a saved path for ten minutes while the same service and page remain available; a service restart loses server receipts and a page reload loses their references. Each file is limited to 10 MiB; at most three uploads are processed concurrently, with a 30-second request deadline and a storage limit of 500 files or 500 MiB. The server checks file signatures and basic structure; it does not fully decode images. The fixture redirects uploads to its own temporary directory.
