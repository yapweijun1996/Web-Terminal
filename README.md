# Web Terminal

An owner-operated browser terminal for accessing a computer through Cloudflare Access and Tunnel. Its implementations use ttyd and tmux to provide terminal views and reconnectable sessions.

## Repository status

The repository contains a [Linux implementation snapshot](docs/linux-implementation.md) and a disposable integration test. The separate running Linux deployment is not automatically synchronized with this repository; this import does not change or deploy it. The Mac implementation remains separately maintained under `~/.local/share/mba-browser-terminal/` and has not been imported. This repository does not yet provide an installer or a reproducible build for the Mac implementation.

On 2026-11-04, the observed Linux environment used Ubuntu 24.04 ARM64, ttyd 1.7.4, tmux 3.4, cloudflared 2026.10.0 and Node.js 22.23.3. The observed Mac environment used ttyd 1.7.7, tmux 3.6a and cloudflared 2025.11.1. These are observations, not repository-pinned dependencies. Windows and WSL remain unverified.

## Documentation

- [Task backlog and acceptance criteria](TASK.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Linux source inventory and evidence](docs/linux-implementation.md)
- [Operations and verification](docs/operations.md)
- [Improvement roadmap and research](docs/improvement-roadmap.md)
- [Documentation standard](docs/documentation-standard.md)

The KB-MCP `cloudflare-web-terminal` Skill v1.1.0 contains the reusable operating procedure and historical evidence. This repository records the project snapshot and open work; verify the current host and Access configuration before relying on either source for a change.

## Safety and scope

An interactive terminal can act with the permissions of its operating-system account. Restrict access to explicitly authorized identities and protect every terminal and upload route. Preserve existing sessions and jobs when investigating or changing the service. Never commit credentials, tokens, private host configuration, logs, uploaded images, or terminal contents.

The Linux UI itself does not authenticate users or verify Access JWTs. It requires a separately configured, verified Access-protected tunnel and a private origin socket; never expose it directly. Documentation and source do not authorize deployment, service restart, permission change, or exposure of another machine.
