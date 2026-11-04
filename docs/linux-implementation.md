# Linux implementation snapshot

On 2026-11-04, the owner-operated Ubuntu 24.04 ARM64 host had a working Linux terminal deployment separate from the Mac implementation. The files under `linux/` are a source snapshot copied from that host; importing them does not deploy them or make this repository the live source of truth. Inspect the host and preserve existing jobs before making changes.

## Source inventory

| Source | Responsibility |
| --- | --- |
| `linux/ui/server.js` | Private Unix-socket UI, per-session ttyd processes, HTTP/WebSocket proxy and session operations. |
| `linux/ui/index.html`, `app.js`, `style.css` | Browser tab controls, connection indication, hide/restore and return-to-latest control. |
| `linux/ui/attach-tab.sh` | Attach a ttyd client to the corresponding persistent tmux session. |
| `linux/legacy-attach.sh` | Earlier grouped-session attachment used by the existing terminal service. |
| `linux/test/integration.test.js` | Disposable server, ttyd and tmux integration fixture; no live sessions or Cloudflare settings. |

The server obtains ttyd's embedded terminal client at runtime and adds a small connection-status hook. The embedded client is not vendored here. The snapshot expects `tmux` on `PATH` and ttyd at `/usr/bin/ttyd`; it has no npm dependencies or build step. Observed host versions were Node.js 22.23.3, ttyd 1.7.4, tmux 3.4 and cloudflared 2026.10.0. These versions are observations, not pinned dependencies or compatibility guarantees.

## Session and scroll behavior

The UI lists the existing shared session and its own named sessions. Each new tab creates a distinct tmux session. Hiding a tab detaches its view without killing the session; Restore tabs makes hidden tabs visible in that browser. Session state is managed by tmux, while hidden-tab preferences are browser-local. The proxy enables tmux mouse mode for a session. The Latest control exits tmux copy mode; it does not submit input or assert that an interactive application's own transcript is at the end.

## Security boundary

The UI and ttyd do **not** independently authenticate the browser or verify a Cloudflare Access JWT. The observed deployment places an Access-protected Cloudflare Tunnel in front of the private UI socket and configures cloudflared to require JWT validation for the application audience on the ingress route. The UI checks origin and a per-process request token for session mutations and checks WebSocket origin; these checks are not a replacement for Access authentication. Terminal execution has the full permissions of its OS user, and processes under that same user can access the private socket.

`TERMINAL_TEST_HTTP=1` is only for a disposable local test fixture. Never use it on a live service. Private hostnames, Access settings, application audience, account details, credentials, logs, terminal output, uploads and user session data are deliberately not included in this repository. The snapshot is not an installer or production deployment recipe.

## Verification and limits

From the repository root on Linux with Node.js, tmux and `/usr/bin/ttyd` installed:

```sh
node --test linux/test/integration.test.js
```

The test starts a dedicated disposable tmux server and private sockets, tests session creation and origin rejection, checks a ttyd WebSocket upgrade, and verifies a fixture job survives UI restart. It cleans up only the fixture it creates. It does not test Cloudflare Access or the live deployment.

During the 2026-11-04 implementation, an isolated Chromium fixture separately exercised tab creation and switching, hide and restore, reload, wheel scrollback, Latest, `less --mouse`, a job surviving UI restart, and a phone-sized layout. The original live pane process survived the authorized tunnel restart. Unauthenticated requests to the deployed page, session API and terminal WebSocket path were redirected to Access. The owner displayed an email-restricted Allow policy, but the policy was not independently queried through Cloudflare's management API.

Authenticated production-browser behavior, denial for an unauthorized identity, existing WebSocket expiry/revocation, physical trackpad and mobile touch, and survival across sleep, logout or reboot were not established by those checks. User-manager lingering was disabled at the observation time. The Linux snapshot does not provide the Mac implementation's image-upload service.
