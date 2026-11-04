# Mac source inventory and reconstruction

Snapshot: 2026-11-04. The reviewed Mac client and runtime were deployed after owner authorization; see the backlog for the limited post-deployment checks. Complete behavior parity and the separately maintained Linux service remain unverified.

| Component | Source and treatment |
| --- | --- |
| Terminal client | `client/src` is based on ttyd 1.7.7, upstream commit `40e79c706be14029b391f369bee6613c31667abb`. The upstream MIT license and Yarn lockfile are included. The existing local viewport and reconnect customizations were reconstructed in the template and TypeScript. |
| Toolbar and upload UI | `client/src/toolbar.*` and `client/src/upload.*` were recovered from the local custom page and formatted as editable source. The initial reconstruction matched the local originals in a normalized comparison. The candidate now intentionally adds connection states and an explicit, pane-bound upload workflow. |
| Runtime | The initial `runtime/upload-server.js` reconstruction matched the local service in an abstract-syntax comparison. The candidate intentionally differs: upload work retains its concurrency slot until completion, `upload-target.js` binds a receipt to an identified tmux pane, and the upload service guards its socket path. `runtime/attach.sh` enables pane metadata only for view-ID-aware sessions, so legacy sessions do not receive its title prefix. The attach and serve scripts use explicit environment configuration, validate view arguments, enable ttyd URL arguments for those IDs, and guard against removing an existing socket. |
| Build and tests | `client/` contains the pinned upstream build configuration, patch and lockfile. `tests/` contains isolated runtime and macOS upload checks. Generated bundles and dependency directories are excluded by `.gitignore`. |

No Mac tunnel configuration, Access identities, hostnames, tokens, uploaded files, logs, terminal history, or user session state were imported into this candidate. Before publishing any future change, review the actual diff and source provenance; an automated pattern scan alone cannot prove the absence of private data. The separate Linux snapshot is described in [Linux implementation](linux-implementation.md).

The candidate upload socket must be in an existing owner-only directory owned by the service user. The service refuses to replace any existing socket path; a graceful stop closes the listener and removes its socket. After an unclean stop, verify that no service still uses the path and inspect the entry before removing a stale socket. This protects the local path from accidental replacement; it does not authenticate same-user processes or establish the Cloudflare Access boundary. The Mac service was updated after these isolated checks; the production Access boundary remains unverified.

## Verification evidence

- An isolated build of unmodified upstream source produced the same SHA-256 as the HTML served by the installed stock ttyd 1.7.7. Two successive candidate builds matched each other, and a clean installation from the staged source produced the same candidate output on this Mac.
- In an isolated Chrome and tmux fixture, the candidate loaded, created a second window through the toolbar, and preserved the same test pane and running job through a page reload. This does not test the live service or every TUI, upload, keyboard, or mobile workflow.
- Local Node tests cover the runtime directory and existing-socket guards, a real isolated ttyd Unix socket, macOS image-service origin, file validation and permissions, and isolated upload interruption and timeout behavior. They do not replace end-to-end Access, live deployment, or physical-device tests.

The build was observed with Node.js 23.10.0, Yarn 3.6.3 and ttyd 1.7.7. Other hosts, toolchain versions, and production deployment remain unverified.
