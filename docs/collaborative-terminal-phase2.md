# Collaborative terminal Phase 2: not release-ready

Status: **incomplete; do not deploy or use as a collaborative security boundary.**
`runtime/collaboration-serve.sh` always exits with an error and starts no service.
It is a fail-closed placeholder, not an input gateway. It does not disable or
protect any separately started legacy service. The existing `runtime/serve.sh`
is unchanged, has no collaboration flag, and starts writable ttyd: legacy
operation is **insecure for collaboration**. Access to it remains full terminal
authority, not a watcher or lease-controlled role.

## Current architecture and threat model

The browser reaches writable ttyd through an Access-protected tunnel; each ttyd
connection attaches a grouped tmux view. The upload service can independently
insert a path through tmux, while MCP can independently send keys and paste.
`mcp-auth` verifies grants but forwards requests without a verified principal or
connection identity to the MCP process. Browser view IDs and target metadata
are correlation data, not credentials. A same-user local process can access
private sockets or tmux and is outside the current remote access boundary.
Neither an Origin check nor an asserted label establishes writer authority.
Explicit `terminal_select` currently selects all grouped views; Phase 1 already
removed the implicit selection on type and key. No selection semantics change is
included here.

An authenticated participant, a watcher, a forged client, or a stolen/stale
connection must not be able to bypass a future gateway by connecting directly
to ttyd, invoking the MCP socket, using upload insertion, sending ttyd control
frames, or changing pane targets. An external Access configuration alone does
not establish per-connection authorization inside these independent services.
Actual JWT, WebSocket Upgrade, origin, token expiry and route configuration were
not verified against a live deployment.

## Required contract before release

A single trusted authority must bind a verified browser or MCP principal and a
server-created connection to a validated pane, serialize ownership claims,
enforce bounded leases and generation checks at every mutation, revoke on
disconnect, and permit explicit authorized takeover. It must mediate input,
paste, control sequences, resize and upload insertion, including error and
reconnect races, without recording terminal content in audit metadata. Direct
ttyd and tmux access must be isolated from untrusted participants. Watch mode
must be server-enforced. Presence must expire and use verified identities.
Navigation must remain per client unless the client explicitly follows, with a
reversible visible control and no implicit takeover. These are requirements,
not implemented guarantees. The existing per-request MCP transport does not
provide the necessary connection-scoped identity contract.

## Rollout, migration and rollback

There is no enabled Phase 2 rollout flag or deployable collaboration mode.
Standalone legacy mode remains the default and is not safe for collaboration.
Before migration, implement and independently verify a gateway and enforce
exclusive routing for **all** three paths, including local-socket exposure and
WebSocket authentication. Plan how existing connections drain, how leases are
invalidated on restart, and how clients detect the protocol version. Running old
and new writable routes concurrently creates a bypass, so zero-downtime safety
is unproven; a brief write interruption may be required. Rollback to legacy
restores unrestricted writable behavior and must not be described as preserving
collaboration protection. No deployment or rollback was performed.

## Verification evidence (2026-11-06)

- `env -u WEB_TERMINAL_MCP_SOCKET npm test` in `mcp`: 3/3 passed outside
  the socket-restricted sandbox using disposable tmux servers. This includes
  existing legacy selection behavior, not collaboration authorization.
- `env -u WEB_TERMINAL_MCP_SOCKET node --test tests/runtime.test.js`: 1/1
  passed outside the sandbox.
- `node --test tests/collaboration-guard.test.js tests/connection-lifecycle.test.js tests/upload-ui.test.js`:
  13/13 passed in the sandbox. The new test proves only the placeholder exits.
- A combined run including `tests/osc52-clipboard.test.js` failed because
  `client/node_modules/typescript` is absent. Client build was not run.
- `env -u WEB_TERMINAL_MCP_SOCKET node --test tests/upload-target.test.js`:
  2/2 passed outside the sandbox with disposable ttyd and tmux. The initial
  sandboxed run had 1 pass and 1 failure because a local TCP listener was denied
  (`EPERM`). This fixture does not test collaborative authorization.
- Two-client collaboration E2E, JWT/Upgrade denial, forged identity, bypass,
  lease races, mobile and accessibility checks were not run. No security or
  release acceptance can be inferred from the tests above.
