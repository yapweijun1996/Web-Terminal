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

## Evidence boundaries

Historical Skill evidence reports that a protected-site Chrome fixture tested ordinary shell scrolling and reconnect while preserving its fixture process, history, and unsent input. Isolated fixtures tested mouse reporting on primary and alternate screens and a separate Codex TUI. These results do **not** prove that the original running Codex pane was repaired: that pane had alternate screen enabled, mouse capture disabled, and its recorded `Ctrl+T` attempt did not open a transcript. Its cause remains unknown.

Physical trackpad behavior, other browsers, unauthorized identities, long-duration behavior, and Windows and WSL operation remain unverified. Inspect the actual target and consult [operations](operations.md) before drawing a current-state conclusion.

## Linux implementation

The imported Linux snapshot adds a Node UI and HTTP/WebSocket proxy behind the dedicated Access-validating tunnel. The UI, ttyd instances and tmux use private Unix sockets or a private tmux server. Each visible terminal corresponds to a persistent tmux session; hiding a tab does not terminate its session. The UI enables tmux mouse handling and exposes a control to leave copy mode. See the [Linux inventory](linux-implementation.md) for the exact source and limits.

The UI does not verify Access JWTs itself. The upstream tunnel must validate each HTTP and WebSocket request; the origin socket must remain private. Other processes running as the same OS user are within the local trust boundary. Login expiry is not proof that an already-open WebSocket has been terminated.

## Authoritative sources and ownership

The running host configuration and source are the authority for its current behavior; Cloudflare configuration and identity-provider policy determine the actual remote access boundary. The imported Linux files are a snapshot and are not automatically deployed; Mac runtime source remains outside this repository. The KB Skill owns the reusable procedure, not authorization or current runtime truth. See the [roadmap](improvement-roadmap.md) for the path to a reviewable source of truth.
