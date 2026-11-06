# Slice 2B: disposable OS-principal isolation candidate

**P0 RELEASE BLOCKED.** This is an independent Linux integration fixture and
minimal trusted supervisor, not a patch to the gateway or a release candidate.
Only Node built-ins and the existing local Docker image are used.

From the repository root on the Docker host:

```sh
node --test isolation-candidate/policy.test.js
sh isolation-candidate/run.sh
```

The shell script is the exact Docker invocation. It uses `--pull=never`, no
network, a read-only root filesystem, a tmpfs, and a read-only bind of **only
isolation-candidate/**. No Docker socket, host home, repository remainder,
production socket or credential is mounted. Image absence fails; nothing is
built or downloaded. Requires Linux container runtime root (overrides the image's
`node` default user). No host users/groups/ACLs are created.

Root orchestrates numeric process credentials: backend UID/GID 21001; gateway
UID 21002, primary GID 22000. Both child identities must have zero effective
capabilities. Root's enumerated container capabilities support setuid/setgid,
fixture ownership/modes, private fixture cleanup and termination of its own
children. It has no SYS_ADMIN capability and the container is not privileged.
The `0700` backend directory contains real tmux 3.x and real readonly ttyd Unix
sockets plus live **fake** Upload/MCP socket servers. Every socket needs a
successful backend connection before EACCES/EPERM can count as gateway denial.
ENOENT, ECONNREFUSED, timeout, absent binaries, or a missing socket fail the run.
The two cat panes and all tmux commands use an explicit fresh private socket.

The supervisor directory is backend-owned, group 22000, mode 0710; its socket
is backend-owned, group 22000, mode 0660. This is the only fixture service the
gateway can reach. Group members cannot list/write the directory or reach raw
backend sockets. Ownership and modes are asserted through stat. Every request
is bounded JSON followed by one newline, with a 2-second socket deadline. A
short-lived client process submits each request using actual setuid credentials.

`policy.js` independently verifies Ed25519 signatures against an issuer public
key pinned at server startup. The root test issuer holds its ephemeral private
key only in memory; neither gateway processes nor the supervisor receive it.
The signed payload includes exact issuer/audience, Writer role, pane, lease,
epoch, millisecond issue/expiry times (maximum 5 seconds), one-use nonce and the
entire operation. Supported operations are printable ASCII literal text
(1–128 bytes), Enter, and lease release. Extra fields, arbitrary commands, shell,
resize, alternate panes, Watcher, bad signatures and malformed claims are denied.
Requests use `{payload,signature}`; payload is base64url JSON and the signature
covers the literal payload string. Claims are not accepted from outer role/UID
assertions. Nonce consumption precedes mutation; failed execution does not
restore authority. Release revokes the configured lease for the server lifetime.

One accepted text and one separately signed Enter produce actual cat output.
Replay, released/old lease and old epoch fail. A correctly signed alternate-pane
request is also denied when sent by backend UID itself. Any assertion failure
makes the runner exit nonzero. Subprocess/command/socket deadlines and a
55-second container-runner deadline bound failures; `--rm` destroys remaining
container processes/tmpfs. Normal cleanup terminates owned children, kills only
the fixture tmux server and removes its directory.

## Existing read-only regression checks

On the Mac host, clear inherited endpoint routing before testing:

```sh
env -u WEB_TERMINAL_MCP_SOCKET -u WEB_TERMINAL_TMUX_SERVER \
  -u WEB_TERMINAL_MCP_SESSION -u TMUX node --test \
  tests/collaboration-gateway-auth.test.js tests/collaboration-gateway.test.js \
  tests/input-broker.test.js tests/collaboration-mvp.test.js \
  mcp/test/input-gateway.test.js mcp/test/http.test.js \
  mcp/test/terminal.test.js mcp/test/sdk.test.js
```

These tests exercise disposable fixtures, including selection inside disposable
sessions. No owner workspace tab is selected. See REPORT.md for observations,
execution failures and the remaining release gate.

## Boundaries not proven

No connection/holder binding: the capability is a bearer grant usable once by
any process that can reach this socket. No live login, browser integration,
external IdP, production gateway wiring or production Upload/MCP policy is
implemented. Fake Upload/MCP proves Unix permission enforcement, not application
semantics. The readonly ttyd launch and blocked socket are verified; this fixture
does not perform a ttyd WebSocket rendering test. Gateway has no output relay.
Lease/replay state is in memory, with a fresh random epoch on each fixture;
there is no durable cross-restart fencing or production supervisor lifecycle.
Same-UID backend code and container/host root remain trusted. This tests UID/DAC
isolation, not general container escape, process resource isolation or a hostile
kernel. Production retains its existing same-UID P0 bypass until a separately
reviewed integration and stronger lifecycle/fencing controls are accepted.
