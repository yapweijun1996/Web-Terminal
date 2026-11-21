# AI Coding Workspace v1

This is the binding implementation contract. **ASSUMPTION** marks a v1 design decision or a mapping that requires verification. Marked requirements apply until revised here. CLI observations come from the supplied Mac probes of 2026-11-21. Linux runtime acceptance requires separate evidence.

## Goals and non-goals

Deliver a chat-first AI coding workspace in the Linux UI, with a built Preact frontend. Implement Claude Code first, then add Codex through `codex exec --json`. Support administrator-configured Project Roots and private GitHub repositories through the server's existing `gh` login. Keep that login server-side.

**ASSUMPTION.** v1 excludes changes to the Mac UI, browser-provided server paths, interactive Codex approvals, and an additional interactive shell inside the workspace. Codex app-server is v2.

## Architecture and data flow

**ASSUMPTION.** Preact sends a project reference, agent selection, prompt, and any attachment IDs to the Linux backend. The session manager owns authorization, session state, sequencing, child processes, and replay. Project helpers resolve the working directory before spawn. CLI adapters translate structured stdout into workspace events and write only supported protocol messages to stdin. The UI renders backend events and sends approval decisions through HTTP. It never connects directly to a CLI or receives raw protocol frames or CLI resume IDs.

`linux/ui/server.js` uses explicit GET mappings for static files and has no CSP in the supplied inventory. **ASSUMPTION.** Build Preact before serving and explicitly register `/workspace` and its built assets. Treat repository-derived text, model output, and tool output as untrusted. Render inert text and prohibit raw HTML injection.

## Session manager and process lifecycle

- **ASSUMPTION.** Allocate opaque workspace session and turn IDs server-side. Pin the owner, agent, and project at creation. Creation and resume return a session ID for subscription before the first turn starts. Reserve the session slot before any asynchronous spawn work. Allow one live CLI process and one active turn per session. End the child after every turn and release the slot only after exit. Reject concurrent turns with `409`.
- **Claude Code 2.1.328.** Use `claude -p --verbose --output-format stream-json --include-partial-messages` with the approval flags below. `system/init` supplies `session_id` and `cwd`. The reported directory is the process working directory. There is no `cwd` flag. `--resume <session_id>` preserves the ID and recalls context.
- **Codex 0.171.0.** `codex exec --json` emits a thread ID in `thread.started`. Non-Git directories require `--skip-git-repo-check`.
- **ASSUMPTION.** Spawn directly with server-owned arguments and the resolved process `cwd`. Store the Claude ID with its owner, agent, and project. Use it for later turns and explicit resume. Reject mismatched or unavailable resume requests. Disable Codex resume until its invocation and context continuity are verified. Label Codex turns as fresh context while resume is unavailable.
- **ASSUMPTION.** Allow at most four live workspace CLI processes per server. Require startup within 30 seconds and cap each turn at 15 minutes, including approval waits. Stop is idempotent. On stop, timeout, or shutdown, invalidate pending approvals, send `SIGTERM` to the CLI process group, and escalate to `SIGKILL` after five seconds if needed. Emit one final event per turn. Explicit stop yields `cancelled`, and failures or timeouts yield `error`.
- **ASSUMPTION.** A browser disconnect leaves the child running within the turn limits. Reconnect using the last applied `seq`. Deliver replay and live events in sequence without a gap between them. Keep an in-memory replay window capped at 1,000 events or 4 MiB per session, whichever binds first, and retain inactive sessions for at most one hour, with a maximum of 20 retained sessions per owner. Bound CLI frame and subscriber queue sizes. Close stalled subscribers and signal an expired or incomplete replay explicitly. A service restart clears v1 workspace session and replay state.

## Unified event model

Every event has `type`, `sessionId`, `turnId`, and `seq`. The table lists event-specific fields. **ASSUMPTION.** `seq` increases strictly per session and is assigned by the manager. The first `session_started` carries the first turn's `turnId`. Subsequent turns retain the workspace `sessionId`. The observed source records are named below. Their normalization is an **ASSUMPTION** unless it simply restates a supplied field.

| Type | Payload fields | Claude Code | Codex |
| --- | --- | --- | --- |
| `session_started` | `sessionId` | First `system/init`; keep `session_id` server-side. | First `thread.started`; keep `thread_id` server-side. |
| `message_delta` | `messageId`, `text` | Text deltas from `stream_event`. | No delta mapping verified. |
| `message_done` | `messageId`, `text` | Final assistant text; reconcile with partial events. | `item.completed` with `agent_message`. |
| `tool_call_start` | `toolCallId`, `name`, `input` | Assistant tool use or host approval request when it arrives first. | `item.started` with `command_execution`; command becomes input. |
| `tool_call_output` | `toolCallId`, `output`, `isError` | User tool result or `system/permission_denied`; deduplicate. | `item.completed` with `command_execution`; use `aggregated_output`, `exit_code`, and `status`. |
| `approval_request` | `approvalId`, `toolCallId`, `toolName`, `input`, `options: ['allow','deny']` | `control_request` with `can_use_tool`. | Unavailable in v1. |
| `approval_decision` | `approvalId`, `decision` | Manager emits after the response is written to stdin. | Unavailable in v1. |
| `turn_finished` | `status: 'success' \| 'error' \| 'cancelled'`, `costUsd?`, `usage?` | `result/success` supplies `total_cost_usd`. Manager finalizes failure and cancellation. | `turn.completed` supplies `usage`. Manager finalizes failure and cancellation. |
| `error` | `code`, `message` | Manager normalizes spawn, stream, timeout, or protocol failure. | Same manager behavior. |

Codex also emits `turn.started`. **ASSUMPTION.** Use it internally. Match partial and final records by stable adapter IDs. A final message replaces the accumulated partial text. A child exit without a valid completion record terminates the turn with a sanitized `error` and `turn_finished`. Preserve structured Codex usage and omit metrics the CLI did not supply.

## Permissions flow

Claude host approval requires `--input-format stream-json --permission-mode manual --permission-prompts host --permission-prompt-tool stdio`. A Write request emits `control_request` carrying `subtype: 'can_use_tool'`, `tool_name`, `input`, `permission_suggestions`, `request_id`, and `tool_use_id`. Send one newline-terminated JSON response on stdin using this shape, with the matching CLI request ID and `behavior` set to `allow` or `deny`.

```json
{"type":"control_response","response":{"subtype":"success","request_id":"request-123","response":{"behavior":"deny","message":"Denied by the workspace user"}}}
```

Deny blocked the action in the Mac probe. `--permission-prompts none` auto-denies. **ASSUMPTION.** Keep CLI request IDs and permission suggestions server-side. Bind opaque approval IDs to the owner, session, active turn, and tool call. Accept exactly one decision, with no persistent grants. After 60 seconds, send deny if the child still accepts input. On protocol failure or failed denial, terminate the turn. Reject stale, duplicate, and cross-session decisions. Show one pending card per approval, including after reconnect.

The Codex app-server schema exposes `CommandExecutionRequestApprovalParams` and `CommandExecutionRequestApprovalResponse`, with `accept` and `acceptForSession` decisions. The live handshake is **UNVERIFIED** and deferred to v2. **ASSUMPTION.** Enable Codex v1 only with a verified restrictive execution policy that needs no browser approvals. Unavailable approval or isolation controls prevent launch.

## Project Roots and GitHub workspace rules

- **ASSUMPTION.** Use `linux/workspace/project-roots.js` (`loadProjectRoots`, `listProjects`, `resolveProjectPath`, `assertStillInsideRoot`). Return opaque IDs and display labels. Require a currently authorized ID and recheck canonical containment immediately before spawn and resume. Reject traversal, symlink escapes, and unavailable roots.
- **ASSUMPTION.** Use `linux/workspace/github-workspace.js` (`parseGithubRepo`, `workspacePathFor`, `createWorkspace`, `cleanupWorkspace`, `redact`). Accept only a validated GitHub repository reference, create inside the server-managed workspace root, and return an opaque ID. Scope workspace access to the requesting owner and the administrator-authorized repository set. The server's `gh` login authorizes provisioning only. Keep GitHub credentials out of browser responses, agent environments, and agent-accessible files or helpers. Remove partial clones and clean up only contained, unreferenced managed workspaces. Never delete a Project Root.
- **ASSUMPTION.** Canonical path checks validate spawn inputs. A separate verified Linux execution boundary must enforce the permitted filesystem and credential scope throughout the turn.

## HTTP/WebSocket API list with auth gates and body limits

The existing JSON POST gate checks `Origin`, `X-Terminal-Request`, and exact `Content-Type: application/json`. Workspace POST routes must use route-local gating and body caps. A global body gate is prohibited.

**ASSUMPTION.** All workspace routes require the Linux UI's authenticated owner authority, plus ownership checks for every referenced resource. A POST must pass the existing mutation checks before body consumption. Enforce caps against declared and actual bytes, including chunked input, and reject oversized requests with `413`. Use this route contract:

| Method and path | Purpose | Maximum body |
| --- | --- | --- |
| `GET /workspace` and explicit built asset routes | Serve the Preact page and bundle. | None |
| `GET /api/workspace/projects` | List available project IDs and labels. | None |
| `POST /api/workspace/github` | Provision a private repository by reference. | 4 KiB |
| `GET /api/workspace/sessions` | List recent session metadata. | None |
| `POST /api/workspace/sessions` | Create or resume using project, agent, and optional workspace session ID. | 4 KiB |
| `POST /api/workspace/sessions/clear` | Clear inactive recent sessions and their replay history. | 1 KiB |
| `POST /api/workspace/sessions/:id/attachments` | Stage JSON-encoded file or image data. | 8 MiB |
| `POST /api/workspace/sessions/:id/turns` | Start a prompt with optional attachment IDs. | 64 KiB |
| `POST /api/workspace/sessions/:id/stop` | Stop the active turn. | 1 KiB |
| `POST /api/workspace/sessions/:id/approvals/:approvalId` | Submit `allow` or `deny`. | 1 KiB |
| `WS /api/workspace/sessions/:id/events` | Replay and stream events. | 1 KiB initial subscription frame |

**ASSUMPTION.** Before upgrading, require the authenticated owner and exact same-origin `Origin`. The first frame specifies `afterSeq` within five seconds. Use `0` before any event has been applied. Reject invalid cursors and additional client frames. On a replay gap, close with a fixed reason and show that history is incomplete. Never put credentials in the WebSocket URL. Bind attachments to the session, validate decoded size and allowed types, cap staging at four files and 16 MiB decoded per session, and expire attachments with the session. Enable file or image submission only for a verified adapter transport.

## Frontend structure and mobile behaviour

- Desktop left sidebar: **New Session**, searchable **Projects**, **Recent Sessions** with **Clear**, **Settings**, **Help**, and the user control.
- Desktop centre: project and agent dropdowns, **Connected** badge, welcome card with **Project**, **Agent**, **Resume session** checkbox, and **Start Coding**, then a chat stream with collapsible tool-step cards and a composer with attach, image, and terminal buttons plus an agent picker.
- Desktop right: collapsible **Terminal** pane. On mobile, use a single chat page with project and agent selectors in the header and a collapsed **Terminal** bar at the bottom.
- Use English labels and inline SVG icons with `currentColor` and accessible labels on icon controls. **ASSUMPTION.** Show **Connected** only after workspace subscription succeeds. Terminal shows the session's authorized command output with read-only controls.

## Global-instruction isolation

Both CLIs loaded the owner's global instructions in the probes, revealing a personal skill and language rules. Isolation is required before either agent is enabled. Exact mechanism: **UNVERIFIED**.

**ASSUMPTION.** Use a dedicated agent configuration and restricted environment that preserves required CLI authentication while excluding owner instruction files, skills, and the provisioning login. Keep project-local instruction handling subject to the execution boundary. Fail closed until Linux probes prove both global instructions and credentials are inaccessible to agent processes and their children.

## Logging rules

Never log query strings, request bodies, headers, tokens, OAuth codes, cookies, or terminal contents. **ASSUMPTION.** Also exclude raw CLI stdout and stderr, prompts, tool payloads, file contents, and local paths. Log allowlisted route names, status, elapsed time, and sanitized error codes. Apply `redact` to GitHub diagnostics before any approved diagnostic leaves the helper.

## Test plan with acceptance checks

**ASSUMPTION.** Release requires the following Linux checks:

1. Build Preact and verify explicit page and asset routes, all desktop and mobile controls, keyboard access, and inert output rendering.
2. Replay both CLI fixtures and run live Linux turns. Check IDs, sequence, partial and final text, tool results, terminal status, and cost or usage. Verify Claude process `cwd` and same-ID context resume. Cover Codex in Git and non-Git directories.
3. Approve and deny a harmless Write. Confirm allow performs the write, deny and timeout block it, and stale and foreign decisions fail. Verify Codex's restricted policy before enabling it.
4. Test conflicting starts, spawn failures, stop, timeouts, child cleanup, reconnect during approval, replay gaps, and restart behavior.
5. Reject invalid origins, tokens, media types, oversized bodies, foreign WebSocket subscriptions, path escapes, and unauthorized repositories. Provision a private repository with server-side `gh`. Verify cleanup and credential isolation.
6. Add harmless markers to owner global instructions and diagnostic inputs. Verify neither CLI loads the markers and none appear in logs. Confirm the existing Linux terminal routes still work.

## Open questions and risks

- Linux CLI parity, Claude stdin prompt framing, exact instruction isolation, and the live Codex approval handshake remain **UNVERIFIED**.
- **ASSUMPTION.** Linux execution containment, Codex resume, and adapter-specific attachment transports need separate acceptance evidence before their dependent capabilities are exposed.
- **ASSUMPTION.** In-memory history and the replay cap can make earlier conversation content unavailable. Show the gap and require an explicit new turn or supported resume. Never silently resend a prompt.
