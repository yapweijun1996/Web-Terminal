# Isolated macOS kernel socket candidate

**OS_ENFORCEMENT_PREPARED / DUAL_PRINCIPAL_NOT_VERIFIED. Not production safe.**

This adds native C code and runnable tests only under the requested candidate
paths. The production Gateway, tmux supervisor, owner browser and existing
`collaboration-gateway` WIP are untouched. No accounts, ACLs, services or launchd
configuration are changed. No commits, staging, merges, pushes or deployment.

## Problem and evidence boundary

The existing collaboration-gateway signed authorization, Slice1 and broker checks
cannot stop a hostile process running under the tmux owner's UID from connecting
directly to private `tmux.sock` and issuing `send-keys`. That accepted baseline
and bypass are supplied task evidence, not rerun against a live terminal here.
A 0700 directory and 0600 socket do not separate hostile same-UID callers.

The candidate live binary refuses `client_uid == geteuid()` before opening any
socket. It rejects UID 0 and set-ID startup. Every accepted peer is checked by
`getpeereid`; expected UID is a strict numeric allowlist, not a claim in a request.
There is no environment/flag bypass. Only the separate diagnostic executable can
exercise a same-UID positive ping. Neither executable contains a writable tmux
path, arbitrary command executor, bearer-token authority, HTTP or TCP listener.

Tests demonstrate native kernel credential retrieval on macOS for the current
UID/GID, denial when a different numeric UID is configured, and refusal of a
same-UID enforcement configuration from a forked child. The negative mismatch
changes configuration only; it is **not an actual second-account E2E test**.
No second account has been invoked, impersonated or authorized by implication.

## Ownership and startup contract

| Resource | Required authority | Current implementation |
| --- | --- | --- |
| Supervisor executable and startup configuration | Trusted S-owned launch boundary; S and C distinct non-root OS UIDs | Candidate runs under its existing login identity; no account switching or launch service |
| Backend private directory | S only, mode 0700, no granting ACL to C | Contract only; no actual backend created or opened |
| tmux.sock, journal, durable fence | S only; files/socket 0600, containing dirs 0700 | No tmux, journal or durable fence path in candidate |
| Candidate socket parent | S owner, mode 0700, no extended ACL, fresh empty directory | Checked with descriptor-relative nofollow traversal and extended stat |
| Candidate socket | S owner, mode 0600, no extended ACL | Checked before listen and before authenticated ping response |
| Future Gateway ingress | Separate S-owned directory, controlled ACL granting only C traversal and socket connection | **P0 / NOT_IMPLEMENTED / NOT_RUN** |

S means a separately provisioned trusted principal, not simply a different process
under the current Gateway UID. C runs the Gateway with no S credentials, S files,
S launch configuration, S debugger/task access or inherited S descriptors. Neither
principal may start an owner shell under S on behalf of C. Configuration and
binary integrity must be outside C's write authority. Root/OS administrators and
compromise of S itself are outside this candidate's isolation claim.

The future ACL ingress directory must be separate from backend storage. Its
reviewed ACL should grant exactly named C traversal on the directory and the
minimum macOS AF_UNIX connection permission on the socket, never directory
mutation, ACL/owner mutation, backend traversal or journal/fence access. Any
inheritance must be deliberately specified and checked for exact entries, rights,
identity and flags. Do not assume numeric modes exclude ACL grants. No broad
group/everyone grant or symlink bridge to backend is acceptable.

**Current verifier rejects every extended ACL.** Therefore C cannot reach the
current private candidate endpoint even when its UID is allowlisted. This is an
intentional closed preparation state, not an operational two-principal gateway.
A reviewed exact ACL verifier and authorized staging are needed before positive
C-to-S ping can be demonstrated. No existing account or ACL is automatically
approved by this document. There is no flag to relax this policy.

## Native lifecycle and failure behavior

`supervisor.c` owns the unconditional distinct-UID check. `diagnostic.c` has its
own one-shot entry point; `socket.c` shares only bounded transport/mock behavior.
No same-UID option exists in the live executable. A process-local monotonic
clock bounds I/O; it is not an authorization epoch.

The listener pins and locks its private directory, binds a relative AF_UNIX
path, sets 0600 before listening, and preserves preexisting entries. Paths must
be absolute, canonical spelling without symlinks, dot components or overlong
socket names. Ownership, exact mode, ACL lookup, frame length and native
credential failures deny. Unknown platform exits 77 with ERR_UNSUPPORTED.
Accepted connections are serial; backlog 4, total 16 in enforcement, idle timeout
3 seconds, absolute frame/response timeout 1 second. The frame includes write EOF
and is exactly 38 bytes. Invalid frames receive no reply. A valid response echoes
a 32-hex nonce plus kernel UID/GID, with no side effect.

Before accepting a directory as having no ACL, the code requires successful
`fstatx_np` and `filesec_query_property(FILESEC_ACL)` with an absent property.
For the socket, it uses `lstatx_np`. It does not interpret `acl_get_fd_np == NULL`
alone as safe. Apple's [extended-stat implementation](https://github.com/apple-oss-distributions/Libc/blob/main/sys/statx_np.c)
populates or unsets ACL properties from kernel results; Apple's
[getpeereid manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/getpeereid.3.html)
describes the peer effective UID/GID captured when connecting. No ACLs are set.

SIGTERM/SIGINT cause bounded shutdown and remove only the socket inode this
listener created. SIGKILL can leave stale state, which is rejected on restart.
The tests intentionally leave a killed listener's socket long enough to prove
stale rejection, then remove their own disposable directory. No automatic stale
socket recovery, file deletion outside the test tree, or live owner operation.

## Verification

Run `node --test tests/collaboration-isolation.test.js` on the actual macOS host.
The test suite compiles with system clang, `-Wall -Wextra -Werror`, creates its own
0700 scratch tree, and cleans its own processes/binaries/sockets. It tests:

- Actual AF_UNIX same-UID diagnostic response containing kernel UID/GID.
- Live same-UID startup refusal, hostile environment strings and unknown flags,
  forked same-UID child connection failure, no socket on preflight failures.
- Live and diagnostic configured UID mismatch; forged request UID has no effect.
- Symlink directory/ancestor/socket, unsafe directory modes, path/UID limits,
  nonempty directory, duplicate server and killed/stale socket preservation.
- Invalid/oversized/NUL/duplicate frames, incomplete EOF, timeouts, 16-connection
  limit, mode changes and replaced socket preservation.
- lsof reports no TCP sockets for both native executables.
- Unsupported compile branch fails closed with no listener (forced `-U__APPLE__`
  on macOS; an actual non-macOS host is not claimed as tested).

Bind can be denied by the Codex execution sandbox. Do not weaken tests or label
socket tests green there: run exactly the suite through MBA `terminal_exec`,
outside tmux. Build/test logs and status are recorded in
`/tmp/mba-os-isolation-candidate-report.md`.

## Future two-principal staging: manual and not run

**NOT_RUN / P0: authorization for distinct S and C is absent.** Existing account
presence is not authorization. Do not use sudo, su, launchctl, dscl or an account
switching script. Do not change OS users or ACLs in this task.

These are exact read-only probe commands for a future authorized staging session;
`probe.js` never switches identities or changes permissions. Paths below must
refer only to a separately approved disposable staging tree, never production
owner tmux. Each principal uses their own directly authenticated session.

1. Authorized operator must first approve the named UIDs and stage an S-owned
   disposable backend socket, journal and fence with the contract above. Verify
   they exist from S. Missing paths do not prove denial. Stage the separately
   reviewed ACL ingress and its exact-verifying candidate implementation; the
   current binary will refuse it. Without this prerequisite, leave positive
   allowed connection **NOT_RUN**, not PASS or SKIP.
2. Compile `supervisor.c socket.c` with the README clang command under S in a
   directory not writable by C. In S's own session, once ACL-aware support has
   been reviewed, launch:
   `./supervisor /ABSOLUTE/APPROVED_GATEWAY_DIRECTORY APPROVED_C_UID`.
   Confirm S's effective UID differs from C, READY and the declared mode. The
   current no-ACL binary can only stage the fully private rejection baseline.
3. Within its bounded idle window, in C's own session run:
   `node collaboration-isolation/probe.js ping /ABSOLUTE/APPROVED_GATEWAY_DIRECTORY/gateway.sock`.
   Require PONG nonce correlation and C UID in reply plus the independent S-side
   `PEER uid=C gid=...` log. A same-UID diagnostic reply cannot substitute.
4. Still in C's session, prove backend paths exist using S's earlier evidence,
   then run all three read-only probes:
   `node collaboration-isolation/probe.js deny-socket /ABSOLUTE/APPROVED_BACKEND/tmux.sock`,
   `node collaboration-isolation/probe.js deny-file /ABSOLUTE/APPROVED_BACKEND/journal`,
   `node collaboration-isolation/probe.js deny-file /ABSOLUTE/APPROVED_BACKEND/fence`.
   Require EACCES/EPERM for each. ENOENT, timeout and protocol errors fail evidence.
   The socket probe sends no bytes; use only a disposable backend mock.
5. A separately authorized third-UID test is needed for wrong-principal rejection
   after ingress ACL reachability; never imply an unapproved third account.
   Recheck C cannot replace ingress/modify ACL, S artifacts or startup config.
   Stop only the scratch supervisor and have the authorized operator remove only
   their own staging artifacts. Capture actual UID/GID, command, result and hashes.

## Remaining release blockers

All remain P0: distinct authorized S/C startup and binary/config integrity;
exact controlled ACL ingress implementation and its real macOS enforcement;
actual C allowed ping plus C backend/journal/fence denial; no inherited privileged
handles; durable monotonic epoch and anti-ABA with an enforceable persistence
source; semantic terminal operation allowlist and revalidation/journal/fence
integration. A nonce, wall clock, in-memory counter or fresh PID is not a durable
epoch. No writable terminal path should be added until kernel credential and ACL
checks are proven together and the remaining write authorization invariants hold.
