# Web Terminal

An owner-operated browser terminal for accessing a computer through Cloudflare Access and Tunnel. The current reference implementation runs on macOS and uses ttyd and tmux to provide terminal views and reconnectable sessions.

## Repository status

The repository contains a reconstructed, isolated development candidate in [client](client/README.md) and `runtime/`. The running Mac implementation is maintained separately under `~/.local/share/mba-browser-terminal/`; it is not automatically synchronized with this candidate. A production deployment or complete behavior parity has not been verified.

The observed Mac environment on 2026-11-04 used ttyd 1.7.7, tmux 3.6a, and cloudflared 2025.11.1. These are observations, not repository-pinned dependencies. Windows, WSL, and Xubuntu are potential future targets, not verified deployments.

## Documentation

- [Task backlog and acceptance criteria](TASK.md)
- [Architecture and trust boundaries](docs/architecture.md)
- [Source inventory and reconstruction](docs/source-inventory.md)
- [Operations and verification](docs/operations.md)
- [Improvement roadmap and research](docs/improvement-roadmap.md)
- [Documentation standard](docs/documentation-standard.md)

The KB-MCP `cloudflare-web-terminal` Skill v1.1.0 contains the reusable operating procedure and historical evidence. This repository records the project snapshot and open work; verify the current host and Access configuration before relying on either source for a change.

## Safety and scope

An interactive terminal can act with the permissions of its operating-system account. Restrict access to explicitly authorized identities and protect every terminal and upload route. Preserve existing sessions and jobs when investigating or changing the service. Never commit credentials, tokens, private host configuration, logs, uploaded images, or terminal contents.

Documentation does not authorize a deployment, service restart, permission change, or exposure of another machine.
