# Architecture and trust boundaries

Snapshot: 2026-11-04. This document records a read-only inspection of the Mac implementation, the imported Linux implementation, and historical KB-MCP evidence. It is not a live health report.

## Intended request path

```text
Browser -- HTTPS --> Cloudflare Access --> Cloudflare Tunnel
                                         |-- terminal --> private ttyd socket --> tmux --> shell or TUI
                                         `-- image upload --> private upload service
```

Cloudflare Access evaluates the visitor; the tunnel configuration must also validate the Access token for each applicable origin route. The terminal executes with the operating-system account's authority. Local processes running as the same user remain a separate trust boundary: a private socket does not distinguish them automatically.

## Observed Mac implementation

| Component | Evidence from read-only inspection | Limit |
| --- | --- | --- |
| Terminal origin | `serve.sh` starts writable ttyd on a Unix socket, enables origin checking, and uses a custom page. | The existence of origin checking does not establish identity or prove the whole path is protected. |
| Sessions | `attach.sh` uses a dedicated tmux server and persistent workspace; browser views attach through grouped sessions. | Browser disconnect, service restart, logout, sleep, and reboot are different lifecycle events. Survival through each is not established. |
| Tunnel | The inspected terminal and upload ingress routes configure cloudflared Access validation and an application audience; the fallback is 404. | Configuration alone does not prove the actual Access policy, unauthorized-user denial, or WebSocket behavior. |
| Uploads | The local service uses a restricted Unix socket and upload directory, request-origin checking, file-type and signature checks, size and image-dimension limits, random names, and exclusive writes. | Protection and failure behavior require end-to-end and adversarial verification; uploaded files are retained. |
| Interface | The page contains a bundled terminal client and local scripts for views and uploads. | The bundled page is difficult to review or upgrade as a single compressed artifact. |

The launchd user service was running during the 2026-11-04 read-only check. A running process alone does not prove the browser can connect securely.

## Mac Access evidence and limits

On 2026-11-04, the Cloudflare dashboard displayed a self-hosted application and an email-based Allow policy for the Mac terminal. The dashboard's policy tester reported one approved active identity; it evaluates previously seen identities and is not a live route or unauthorized-user test. Separate HTTPS requests with no browser credentials received Access login redirects for the terminal page, token endpoint, ordinary WebSocket URL, and upload GET and empty POST. The request to the WebSocket URL did not include an Upgrade. An existing browser profile displayed the upload service's expected rejection body for a GET, but the response alone does not establish the browser identity or a successful authorized upload.

These checks do not establish denial of a separately authenticated unauthorized identity, audience validation on every route, behavior of a real WebSocket Upgrade, or expiry and revocation of new and already-open connections. The Linux implementation and any other application have separate boundaries. No Access configuration was changed. Do not infer the current policy from this dated snapshot; verify it privately before a change.

## Mac development candidate: upload target

The undeployed candidate correlates each browser view with a dedicated grouped tmux session using a validated random view ID. tmux includes the current pane ID in its terminal-title output; the client strips that metadata from the visible title and snapshots the last confirmed target at upload start. The private upload service verifies that the session and pane belong to the view, associates the saved path with a short-lived receipt, and inserts only on an explicit request for that captured pane. The view ID is correlation data, not an authentication credential; Access, origin checks and private sockets remain the security boundary. If target metadata is absent or invalid, the result can only be copied. A URL argument is accepted by ttyd only for this validated view ID, and the attach script rejects malformed or additional arguments.

## Evidence boundaries

Historical Skill evidence reports that a protected-site Chrome fixture tested ordinary shell scrolling and reconnect while preserving its fixture process, history, and unsent input. Isolated fixtures tested mouse reporting on primary and alternate screens and a separate Codex TUI. These results do **not** prove that the original running Codex pane was repaired: that pane had alternate screen enabled, mouse capture disabled, and its recorded `Ctrl+T` attempt did not open a transcript. Its cause remains unknown.

Physical trackpad behavior, other browsers, unauthorized identities and long-duration behavior remain unverified for those fixtures. Native Windows evidence is scoped separately below; WSL deployment remains unverified. Inspect the actual target and consult [operations](operations.md) before drawing a current-state conclusion.

## Linux implementation

The imported Linux snapshot adds a Node UI and HTTP/WebSocket proxy behind the dedicated Access-validating tunnel. The UI, ttyd instances and tmux use private Unix sockets or a private tmux server. Each visible terminal corresponds to a persistent tmux session; hiding a tab does not terminate its session. The UI enables tmux mouse handling and exposes a control to leave copy mode. See the [Linux inventory](linux-implementation.md) for the exact source and limits.

The Linux candidate similarly passes tmux pane metadata through the embedded ttyd client and uses short-lived server-side receipts for saved images. Its session and pane identifiers are checked against the dedicated tmux server before explicit insertion. The per-process mutation token and same-origin check are additional request checks, not substitutes for Access on the image and receipt routes.

The UI does not verify Access JWTs itself. The upstream tunnel must validate each HTTP and WebSocket request; the origin socket must remain private. Other processes running as the same OS user are within the local trust boundary. Login expiry is not proof that an already-open WebSocket has been terminated.

## Native Windows adapter

The separate [Windows adapter](../windows/README.md) routes HTTPS through a
dedicated Access-validating tunnel to a loopback Node HTTP/WebSocket service.
The service also verifies Access JWT signature, issuer, audience, expiry and the
configured owner email on every route and upgrade. Mutations require an exact
Origin and request token. WebSocket connections close at JWT expiry; immediate
revocation is a separate, unverified property.

Each PowerShell shell runs through ConPTY in a dedicated worker process, with
headless screen state retained by the service. Browser disconnects and hidden
views leave the worker running; explicit End terminates it. This is separate
from tmux: service restart, logout and reboot end its shells. Same-user local
processes remain trusted. Upload and MCP routes are not implemented by this
adapter. The launcher and owner-scoped interactive logon task manage only this
terminal and connector. Local settings and tunnel credentials are excluded from
Git. Native integration and owner-confirmed basic browser acceptance are
documented in the adapter README; logon, revocation and full browser lifecycle
acceptance remain incomplete.

## Authoritative sources and ownership

The running host configuration and source are the authority for its current behavior; Cloudflare configuration and identity-provider policy determine the actual remote access boundary. The imported Linux files are a snapshot and are not automatically deployed. The [reconstructed Mac development candidate](../client/README.md) is also separate from the live service; its runtime configuration is explicitly supplied and its socket guard differs from the live script. Full parity remains to be established. The KB Skill owns the reusable procedure, not authorization or current runtime truth. See the [roadmap](improvement-roadmap.md) for the path to a reviewable source of truth.

### Mac window controls candidate

The Mac browser strip uses the existing private same-origin control endpoint to list, select and close windows in its confirmed grouped view. The inline × hides through browser-local state; the separate End window modal captures a stable tmux window ID; the backend validates view/session/pane metadata and checks server PID, session ID, window identity and remaining window count in tmux before a close. It uses `kill-window`, preserving the session and other windows. Shared grouped views observe the same window deletion. Browser-list opt-in hides the native status row in the validated grouped view only; a reachable list failure restores its saved status before hiding browser controls. The workspace/global defaults and legacy views retain their native status. A completely unavailable control service requires recovery or a fresh connection for native navigation. The browser strip, scoped toolbar CSS and paired control backend received an owner-authorized minimal live port on 2026-11-06; TASK.md records the isolated and authenticated live acceptance separately. The full repository runtime remains a separately maintained candidate.

The IDE-style strip stores names, pin/order and hidden state by server PID/window ID in browser storage. Those preferences never mutate tmux. The searchable switcher includes hidden windows, confirmed process basenames and connection availability without claiming task health. All-hidden views conceal terminal output while retaining the attachment. Workspace tools reuses original toolbar nodes and handlers.
