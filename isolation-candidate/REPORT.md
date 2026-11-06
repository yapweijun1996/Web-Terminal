# Slice 2B observed evidence — 2026-11-06

**Candidate delivered; P0 RELEASE BLOCKED; manager acceptance pending.**

## Scope and provenance

Started at branch `codex/mba-collab-20261106`, HEAD
`2b22b2a4afd5bde8d86ddbaa15e58a9b37e95451`. All new files are under
`isolation-candidate/`. Existing tracked files and untracked Slice 2 WIP were
read-only; no commits, pushes, merges, deployments, image builds/pulls, host
OS principal changes or owner-workspace selections were performed.

Sandbox Docker access returned permission denied; the authorized MBA Terminal
`terminal_exec` host executor ran Docker and host regressions. Local image:
`web-terminal-test:wt009-final-20261104`, observed image ID
`sha256:673c8f8c434e4d2df3f5880d4d1539d8182b585054978784463f245f05eafc83`.
The image's default user is node, so the command explicitly sets container root.
Observed container Node v22.23.4 and real tmux 3.7c. No production mounts;
only the candidate directory is bound read-only. The exact repeatable Docker
command is in run.sh and has been executed through `/bin/sh` as documented.

## Final results

| Check | Observed result | Exit code |
| --- | --- | --- |
| Small policy test before implementation | Expected MODULE_NOT_FOUND failure | 1 |
| Final `node --test isolation-candidate/policy.test.js` | 1/1 passed, no skipped tests | 0 |
| Container integration before final capability assertions | 37/37 passed | 0 |
| Final `sh isolation-candidate/run.sh` | 37/37 passed, zero effective capabilities in both child principals | 0 |
| Clean-environment host Slice 2 related checks | 12/12 passed | 0 (combined 16-test run) |
| Clean-environment host MCP checks | 4/4 passed | 0 (combined 16-test run) |
| Docker resource inventory after earlier attempts | No containers using the local test image remained | 0 |

Final run.sh execution ID: `125c18dd-effb-4abd-88f4-9d36f66d4fad`,
Docker process duration 1156 ms, stdout not truncated, stderr empty.
Combined 16-test host execution ID: `b9222e6b-b9e4-478f-91e7-b49ce1e71f78`,
8956 ms, no skipped/cancelled tests, stderr empty. MCP printed the existing
`no server running` cleanup diagnostic for its disposable tmux fixture while
all four MCP tests passed; this is not evidence about a production server.

The 37 container checks include:

- Linux platform, root orchestrator, no-new-privileges and EROFS root write probe.
- Real tmux server, actual backend cat UID 21001, backend send-keys positive
  control, cat echo/output capture and a distinct alternate pane.
- Backend process getuid=21001, getgid=21001, groups=[21001]; gateway
  getuid=21002, getgid=22000, groups=[22000]. Both CapEff=0000000000000000.
- stat: private directory 21001:21001 mode 0700; supervisor directory
  21001:22000 mode 0710; supervisor socket 21001:22000 mode 0660.
- All raw sockets live and backend-owned, with successful backend connection
  controls. Gateway traversal and each connection fail specifically EACCES.
  Socket observed modes: tmux 0600, readonly ttyd 0660, fake Upload/MCP 0700.
  Parent mode 0700 enforces privacy regardless of these socket mode differences.
- Reachable supervisor returns DENIED for unsigned role/UID assertions, wrong
  issuer key, Watcher, alternate pane, old lease, old epoch, expired/future/too
  long capability, unknown/shell/resize/raw tmux operations, control characters,
  extra asserted UID and invalid key. Backend UID is also denied a correctly
  signed alternate-pane request.
- Signed Writer literal text accepted exactly once, replay denied, separately
  signed Enter accepted, actual cat echo plus cat output observed. No forbidden
  marker and no mutation marker in alternate pane.
- Released lease rejected for gateway and backend callers. Owned server/ttyd
  stopped, fixture tmux killed, temporary fixture directory absent after cleanup.

The final script was independently repeated after documentation: execution ID
`206fb88a-d325-4e01-993f-add1c6584845`, 1191 ms, 37/37, exit 0,
empty stderr. Final label-filtered Docker inventory was empty (exit 0).
Tracked `git diff --exit-code` passed; all six original Slice 2 WIP file hashes
matched intake. Additional unrelated untracked `collaboration-isolation/`,
`docs/collaboration-isolation-candidate.md`, and
`tests/collaboration-isolation.test.js` appeared concurrently; this worker did
not read or modify them.

## Failed attempts and execution deviation

Connector schema rejections (match count and timeout range) did not execute
commands. An initial Docker host-executor request returned an internal error;
resource inventory showed two matching candidate runner containers. Their logs
showed cleanup failure: root could not chmod another UID's socket or terminate
another UID after dropping capabilities. FOWNER and KILL were added only to the
container root orchestrator; child CapEff is independently asserted zero.
An intermediate run exited 1 because the probe parsed the fake socket banner as
JSON. Probe and protocol parsing were separated; the full suite then passed.
No denial was inferred from those failures, and no unrelated process was killed.
Both early containers disappeared through their deadline and `--rm`, confirmed
by an empty image-filtered Docker inventory.

The first host MCP regression run was 3/4, exit 1: SDK test inherited
`WEB_TERMINAL_MCP_SOCKET` from the host executor. Existing server startup called
lstat on that inherited socket path and failed with `Socket exists`. This was
an unintended socket existence inspection outside the requested boundary.
There was no socket connection, message, mutation, credential output or service
restart. The path was not printed or further inspected. This deviation cannot
be undone and is explicitly disclosed. The invocation was corrected to unset
MCP/socket/tmux routing variables before Node startup; all 16 existing tests
then passed. No existing tests or implementation files were edited.

## Residual P0 and release gate

This closes a **disposable Linux UID/DAC proof gap**, not the live same-UID
bypass. The candidate is not wired to Slice 2 or production. Production remains
unchanged and same-UID raw tmux bypass remains a release-blocking P0.

The issuer is test-only. Capabilities are bearer grants without holder/connection
binding. There is one configured lease, in-memory nonce/release state and a
fresh fixture epoch; durable restart fencing, real issuer/identity integration,
browser login, output relay, production supervisor ownership/lifecycle and
real Upload/MCP endpoint policies remain unproven. Upload/MCP are deliberately
fake live socket services. Readonly ttyd is real and socket-isolated, but this
candidate does not test its WebSocket output path. Host/container root and the
backend UID are trusted; this is not a container-escape or comprehensive process
sandbox proof. Public release requires manager acceptance and separately
verified production integration resolving these gaps. No release-ready claim.

## Exact new file list

- isolation-candidate/README.md
- isolation-candidate/REPORT.md
- isolation-candidate/policy.js
- isolation-candidate/policy.test.js
- isolation-candidate/run.sh
- isolation-candidate/runner.js
- isolation-candidate/worker.js

No reusable/global skill or memory writes were needed or authorized for this
project-specific candidate. Missing routed instruction modules were handled
with the supplied global core and available local evidence.
