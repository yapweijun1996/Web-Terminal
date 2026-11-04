# Mac source inventory and reconstruction

Snapshot: 2026-11-04. The development candidate is separate from the running service. Do not infer deployment or complete behavior parity from this inventory.

| Component | Source and treatment |
| --- | --- |
| Terminal client | `client/src` is based on ttyd 1.7.7, upstream commit `40e79c706be14029b391f369bee6613c31667abb`. The upstream MIT license and Yarn lockfile are included. The existing local viewport and reconnect customizations were reconstructed in the template and TypeScript. |
| Toolbar and upload UI | `client/src/toolbar.*` and `client/src/upload.*` were recovered from the local custom page and formatted as editable source. A normalized comparison of the recovered scripts and styles matched the local originals. Their existing behavior, including open issues, is not represented as fixed. |
| Runtime | `runtime/upload-server.js` was recovered from the local service and formatted; an abstract-syntax comparison matched the original. `runtime/tmux.conf` mirrors the inspected configuration. The attach and serve scripts use explicit environment configuration and add a guard against removing an existing socket, so they are candidates rather than byte-identical live scripts. |
| Build and tests | `client/` contains the pinned upstream build configuration, patch and lockfile. `tests/` contains isolated runtime and macOS upload checks. Generated bundles and dependency directories are excluded by `.gitignore`. |

No Mac tunnel configuration, Access identities, hostnames, tokens, uploaded files, logs, terminal history, or user session state were imported into this candidate. Before publishing any future change, review the actual diff and source provenance; an automated pattern scan alone cannot prove the absence of private data. The separate Linux snapshot is described in [Linux implementation](linux-implementation.md).

## Verification evidence

- An isolated build of unmodified upstream source produced the same SHA-256 as the HTML served by the installed stock ttyd 1.7.7. Two successive candidate builds matched each other, and a clean installation from the staged source produced the same candidate output on this Mac.
- In an isolated Chrome and tmux fixture, the candidate loaded, created a second window through the toolbar, and preserved the same test pane and running job through a page reload. This does not test the live service or every TUI, upload, keyboard, or mobile workflow.
- Local Node tests cover the runtime directory and existing-socket guards, a real isolated ttyd Unix socket, and basic macOS image-service origin, file validation, and permissions. They do not replace end-to-end Access, interrupted-upload, or physical-device tests.

The build was observed with Node.js 23.10.0, Yarn 3.6.3 and ttyd 1.7.7. Other hosts, toolchain versions, and production deployment remain unverified.
