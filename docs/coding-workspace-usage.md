# AI Coding Workspace: usage and operations

Status as of 2026-11-22. This guide describes the Linux UI feature in `linux/workspace/` and `linux/workspace-ui/`. It is source documentation, not a statement about any deployment. The design and acceptance rules are in [coding-workspace-spec.md](coding-workspace-spec.md).

## What it is

A chat-first page served at `/workspace/` by the Linux UI. The server starts a real Claude Code or Codex CLI process in a project directory chosen from admin-defined Project Roots, streams its events to the browser, and shows approval requests as buttons. An optional Terminal panel embeds a real shell in the same project directory.

## Enabling it

The feature is off unless the server is started with these environment variables:

| Variable | Effect |
| --- | --- |
| `WEB_TERMINAL_WORKSPACE_CONFIG` | Absolute path of a JSON config file (below). Required for the workspace routes and the `/workspace/` page. |
| `WEB_TERMINAL_WORKSPACE_TERMINAL=1` | Additionally enables `POST/DELETE /api/workspace/terminal` (a full shell; requires verified owner authority and fails closed otherwise). |

With both unset the server behaves exactly as before.

## Config file

```json
{
  "roots": [{ "id": "main", "label": "Main", "path": "/absolute/project/root" }],
  "workspacesRoot": "/absolute/dir/for/managed/clones",
  "github": { "repositories": ["owner/repo"] },
  "claude": {},
  "codex": { "home": "/absolute/dedicated/codex/home" },
  "mcp": { "claude": { "configFile": "/absolute/0600/mcp.json" } },
  "models": {}
}
```

- `roots`: the only places the browser can pick projects from. The browser sends a root id and a relative folder, never a path. Paths are resolved with `realpath` and re-checked immediately before a CLI starts.
- `workspacesRoot` and `github.repositories`: GitHub repositories are cloned by the server into system-generated paths and only if listed. Credentials stay on the server.
- `codex.home`: a dedicated directory. It must not be the owner's own `~/.codex`. Put `auth.json` (or a symlink to it) and, if wanted, only the `[mcp_servers.*]` tables in `config.toml` there.
- `mcp.claude.configFile`: passed as `--mcp-config` together with `--strict-mcp-config`. It must be an absolute regular file with mode `0600` or `0400`, outside every Project Root and the workspaces root.
- `models`: optional allowlist override. Built-in defaults list the Claude and Codex models and efforts; the default effort is `medium`.

## Isolation of the agent CLIs

Claude Code runs with `--setting-sources project --disable-slash-commands --strict-mcp-config`, so the owner's global skills, slash commands, MCP servers and instruction files are not loaded. Codex runs with a dedicated `CODEX_HOME`. This is deliberate. MCP access is therefore explicit: add servers through `mcp.claude.configFile` and the dedicated Codex `config.toml`.

## Sessions

- One CLI process per chat session. Model and effort are fixed for the session; changing them starts a new session.
- Stopping a session ends its process. A bounded history file (agent, root id, relative folder, CLI session id, model, effort, last used time; mode `0600`) lets a session be resumed after Stop or a server restart, only inside the same project.
- The request token is generated per server start. The page refetches it once on a 403 and ends a session cleanly when the server no longer knows it.
- Approvals: Claude Code approval requests are shown as Allow/Deny buttons. Codex `exec` has no approval events; its sandbox mode is the only control.
- Thinking: Claude emits thinking blocks with token estimates and usually no text; Codex `exec` emits no reasoning items. The UI shows a collapsed Thinking row only when events arrive.

## Deploying a new build

The host runs the Linux UI from a release directory selected by a systemd drop-in (see [operations](operations.md)). A workspace build is the live release plus the `linux/workspace/` and `linux/workspace-ui/dist/` files and the `server.js`/`attach-tab.sh` patch. Build `dist/` with `node build.mjs` in `linux/workspace-ui/`. Back up the drop-in directory, switch `ExecStart`, restart only the UI unit, and compare tmux session names and pane PIDs before and after. Rollback is the previous `ExecStart`.

## Tests

- `cd linux && node --test test/<file>.test.js` for each workspace test file; `cd linux/workspace-ui && node build.mjs && node --test test/*.test.js` for the UI.
- On a machine without `ws` installed, or without Linux-specific paths, five existing files already fail or time out (collaboration-integration, collaboration-telemetry, context-paste, integration, session-start-directory). Compare per-file results against `origin/main` rather than the full-suite total.
- A real browser against the real ingress is needed to confirm the page behind Cloudflare Access; unit tests do not cover it.
