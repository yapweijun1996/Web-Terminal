# macOS native peer-credential mechanism candidate

**Current candidate:** see the NP-01/NP-03 process-isolation section below. Earlier host results are historical and do not accept this revised source.

**Release gate: native Trusted Writer and deletion are prohibited. Do not merge or deploy on the basis of this experiment.** This isolated, test-only executable is not imported and does not change the MCP tool surface. The existing trusted transport and writer continue to return `TRUSTED_VERIFIER_UNAVAILABLE`; recovered records remain ineligible for automatic deletion. This is not a mutually authenticated production service.

## Scope and evidence

The standalone probe creates a stream listener in a caller-provided private 0700 directory. The Node tests create an unpredictable directory using `mkdtemp` in `os.tmpdir`, compile with `clang -Wall -Wextra -Werror` there, and remove it afterward. A forked client connects to the listener. The server obtains `getpeereid` and `LOCAL_PEERCRED` on the **accepted** socket, checks returned structure length, version, group count, effective UID and primary group consistency. The client separately snapshots the server on its connected socket. The client transmits an explicitly untrusted `claimed_uid`; the standalone policy rejects an actual peer sharing the owner UID regardless of the claim. All other peers are also rejected as unverified. Partial I/O uses nonblocking message calls with poll and monotonic operation deadlines; accepted input and child reaping are bounded. The probe ignores SIGPIPE, uses no socket options for timeouts or SIGPIPE, and marks descriptors close-on-exec. Socket path and private modes are checked. Peer PID is never used for authentication; only unreaped, directly forked child PIDs are used for fixture supervision. `LOCAL_PEERPID` is reported unsupported because its ABI and security semantics have not been independently established.

**Independent host verification (MBA-Terminal, 2026-11-06):** The updated C source passes `clang -Wall -Wextra -Werror` on macOS 27.0.1 arm64. After replacing unreliable socket-option timeout setup with monotonic `poll` deadlines, three consecutive native-only test runs on the normal MBA-Terminal execution host each passed **5/5**, including accepted/connected kernel credentials, forged claimed UID rejection, real SCM_RIGHTS transfer, timeouts, permissions and path bounds. An independently rerun full MCP suite passed **80/80** and OAuth passed **20/20**. Each run was an actual process execution and reported exit code 0. In contrast, Codex's isolated sandbox intermittently rejected Unix-socket `bind` with `EPERM`; those sandbox failures must not be hidden or conflated with host outcomes. These observations establish the same-UID native mechanism only; they do not demonstrate any different-UID trusted service or production authorization.


**Simulated/test-only:** the claimed UID is client-controlled, and same-principal rejection is a policy demonstration rather than successful distinct-principal authorization. The separate SCM_RIGHTS experiment transfers the actual accepted descriptor over a test socketpair and compares the received descriptor's peer snapshot to the server's snapshot. This is not a test across distinct OS principals: equal UID/GID values alone cannot establish who currently holds a descriptor or distinguish transfer from same-principal access. Ancillary data and descriptor passing must be denied by any future protocol until a reviewed design establishes safe handling. The test-only descriptor transfer does not implement that policy.

**Unverified:** cross-principal isolation, credential snapshot timing and behavior after identity changes or descriptor transfer between distinct principals, server endpoint identity, robust handling of all ancillary data, `LOCAL_PEERPID`, and production authentication or deletion. Native socket credentials are connection-related snapshots, not proof of the current process using a shared descriptor, executable identity, lifecycle, or completion. A protected endpoint and authenticated peer in both directions are required; this probe does not provide them.

**Superseded vulnerability (prior revision only):** the accepted-socket frame path swept descriptors 0–1023 against a pre-receive snapshot after `MSG_CTRUNC`. That approach could close unrelated concurrent descriptors and missed higher descriptors. The NP-01/NP-03 candidate below removes the snapshot, counts, and sweep entirely. None of the historical test passes establishes safety of that old design.

The disposable fixture checks every canonical temporary-path ancestor with `lstat`: root or current-UID ownership and no group/world write are required, except for root-owned sticky `/private/tmp`. Current-UID-owned ancestors are controlled by a same-UID adversary, so these checks detect accidental drift only and do not establish OS-level isolation. The leaf is 0700 and checked against its opened directory descriptor. After bind, the probe records the socket device and inode, verifies its type and owner, uses `fchmodat` through the directory descriptor, and checks identity and 0600 mode again. Cleanup checks the directory and socket identity before `unlinkat`. These pathname operations have TOCTOU windows: a same-UID adversary can replace the target between checks and chmod or unlink, and the first post-bind lookup cannot prove the object is the one bound. No atomic compare-and-unlink or same-UID malicious-race safety is claimed. Do not run the fixture in a directory accessible to an adversary.

## Future prerequisites

An independently reviewed macOS deployment needs separate least-privileged service and command OS principals, provisioned by authorized operators, with protected executables, configuration, parent directories, endpoint and data, and verified restrictions on impersonation, debugging, signaling and descriptor inheritance. Both the authoritative supervisor and writer need the protected principal. Unix sockets offer native credential access and a small IPC surface but require careful endpoint, credential lifetime and descriptor-transfer controls. XPC may offer platform-managed service lifecycle and audit-token based identity checks, but still needs independently reviewed identity, code-signing, privileges, endpoint and FD-sharing policy; neither approach alone proves a job outcome.

A protected supervisor, authoritative proof store, durable anti-replay/rollback anchor, crash recovery, and trusted atomic conditional deletion remain P0. Missing evidence or uncertainty means denial. No user, service, launch configuration, credential, or production system is provisioned or modified by this experiment.


### Historical follow-up repair status (superseded source)

The updated ancestor policy permits safe-mode current-UID ancestors solely for this disposable probe. The Codex sandbox allows the path checks but denies Unix socket bind with `EPERM`; therefore the pathname-based socket mode operation and ancillary scenarios require a fresh independent MBA host run. Earlier host results above apply to the earlier source and do not verify this revision. P1/P2 closure and production use remain prohibited pending independent verification and resolution of the races and ancillary limitations above.

Latest sandbox checks on this revision: strict clang syntax passed; a standalone native run passed 2/8, with six bind EPERM failures. A separate full MCP run passed 83/83, including all eight native cases, and OAuth passed 20/20. The differing bind outcomes show the sandbox is not a substitute for independent host acceptance.


### Historical MBA-Terminal acceptance of pre-isolation P1/P2 revision (2026-11-06)

Native tests passed 8/8 on three consecutive independent host runs, including real accepted UDS credentials, forged UID rejection, SCM_RIGHTS transfer, unexpected and multi/truncated FD rejection, timeout, directory symlink and nested path rejection. Independently run full MCP passed 83/83 and OAuth 20/20; strict clang and JavaScript syntax checks are required before final acceptance. Codex sandbox EPERM results are distinct from the native host outcomes. This evidence validates the isolated disposable probe, not cross-UID authority, a production ancillary policy or atomic filesystem deletion. That historical revision used a truncated-FD sweep over descriptors 0-1023, could close unrelated FDs in a concurrent process and could not be promoted to the trusted writer. Its host results do not verify the new process-isolation candidate. Path-based fchmodat/unlinkat still have check-to-use races. The trusted Registry Writer, separate OS principal, verified lifecycle proof and automatic deletion remain disabled.


## NP-01/NP-03 process-isolation repair candidate (2026-11-06)

**Status: candidate implemented; independent pathname/whole-suite host acceptance remains BLOCKED.** This section supersedes earlier implementation descriptions. Branch remains `codex/mba-native-peercred-pom-20261106`, base HEAD `4f62bbb5`. Only the pre-existing untracked C probe, JS test file, and this document are edited. All seven pre-existing `.mba-*.md` task prompts are preserved byte-for-byte. No commit, push, merge, deploy, launchd, OS-account, service configuration, production, runtime integration, or MCP-tool changes are authorized or performed.

### Lifetime and rejection boundary

The supervisor creates an actual connected AF_UNIX stream (pathname listener in the original tests; a separate `socketpair` family in the new Golden tests). It forks a sender and one disposable receiver for that connection. The supervisor never calls `recvmsg` on the untrusted stream. The receiver closes the known listener, directory, side-channel, lifetime-read, gate, report-read, and unrelated-sentinel handles before receiving. The supervisor closes its accepted-socket copy. The lifetime pipe's write end is closed in the supervisor **before** the receiver fork, so the receiver cannot inherit it accidentally; only SCM_RIGHTS can deliver it to the receiver. The post-fork unrelated FD cannot be inherited either. The fixture launcher supplies stdio only; all explicitly created original handles have CLOEXEC. This is a closed, standalone, single-threaded test executable, not an embeddable supervisor or a general inherited-FD sanitizer. Fork still inherits memory and stdio and does not establish a distinct security principal.

Every frame byte uses bounded `recvmsg`. Valid, complete SCM_RIGHTS controls are rejected, and only descriptors explicitly in their validated `CMSG_DATA` payload are closed. The parser first validates the entire control buffer, including alignment, header and payload bounds, integer payload size, all message offsets, and control type. Multiple complete headers are handled. Unknown controls, malformed structures, extra flags, `MSG_CTRUNC`, and `MSG_TRUNC` reject; truncated or malformed buffers are never treated as an inventory and are not parsed for guessed handles. Darwin's echoed input bit `MSG_DONTWAIT` is explicitly masked; all other returned flags deny. Every `recvmsg` error ends the receive operation without retrying it. EOF, deadline, and oversized/incomplete frames also exit without authority.

On rejection the receiver performs no further untrusted receive and ends with `_exit`; the OS closes its remaining descriptors, including any invisible installed rights and high-number descriptors. There is no descriptor snapshot, FD count, FD-range scan, close-all primitive, or restoration/resumption of an uncertain receiver. A fixed-size local diagnostic is not an authorization reply. Exit status zero means the fixture verified a rejection scenario, never that a peer was authorized. The separate accepted-FD transfer demonstration receives only in the disposable sender process and remains explicitly test-only.

The supervisor resets SIGCHLD to its default disposition with no `SA_NOCLDWAIT`, installs no reaper or asynchronous kill timer, and uses `waitpid(own_child, ..., WNOHANG)` for exactly its own unreaped fork children. A deadline can signal that unreaped child once with SIGKILL; only this supervisor can reap it, so its PID cannot be reused between the check and signal. After successful wait it never signals that PID again. Wait errors or failure to reap within the final bound cannot report success. Normal receiver wait is 2000 ms, timeout-fixture wait 100 ms, post-kill wait 1000 ms, sender wait 2500 ms, receive deadline 1000 ms, and report/EOF polls 500 ms. Pathname accept is nonblocking and bounded. A kernel task stuck in termination may exceed the bound; that is failure/unknown, never successful cleanup. Arbitrary peers cannot make a production process exit because this code has no production integration.

Apple's archived native contracts state that process exit closes open descriptors, `waitpid` selects an own child and reports termination, and `recvmsg` carries SCM_RIGHTS and truncation flags. These contracts support the architecture, rather than proving behavior of every current Darwin kernel: [Apple `_exit(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/_exit.2.html), [Apple `waitpid(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html), [Apple `recvmsg(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/recvmsg.2.html). Current native fixtures supply the runtime evidence below.

### Golden evidence and limits

| Case | Actual mechanism and required assertion |
| --- | --- |
| Visible 1 and 2 FDs | Real connected socket sendmsg/recvmsg, explicit visible closes equal 1/2, denied frame, receiver reaped, lifetime pipe EOF, unrelated parent FD checks |
| Truncated 1, 2 and 32 FDs | Control capacities `CMSG_LEN(0)`, `CMSG_SPACE(sizeof(int))`, and `CMSG_SPACE(16*sizeof(int))` force `MSG_CTRUNC`; zero guessed explicit closes; receiver termination plus pipe EOF proves no transferred writer references remain |
| High FD >1023 | Sender uses `F_DUPFD_CLOEXEC` at 1101. Receiver deliberately reserves owned low slots up through 1100 and observes a pipe writer actually installed at 1101 after truncated receive, before exit. This targeted observation never drives cleanup. Receiver exit and EOF then prove that reference is gone. Only this disposable executable's soft RLIMIT_NOFILE may be raised within its existing hard limit; OS resource refusal is an explicit missing/skip, never a high-FD pass |
| Concurrent unrelated creation | The supervisor really loops over open/write/close while the separate receiver performs truncated recvmsg. Monotonic syscall-entry/return intervals must overlap in at least one of eight bounded attempts. Every newly opened handle is exercised before its explicit close; an additional held post-fork FD and pre-existing sentinel pipe must still work after receiver reap. No mock, artificial delay, or FD snapshot stands in for concurrent execution |
| Later ancillary message | A test-only reply barrier proves all 12 prefix bytes were consumed in 12 earlier recvmsg calls before the sender sends SCM_RIGHTS. The thirteenth call rejects; no partial claim grants trust |
| EOF/error/deadline/overflow | Actual peer close, an intentionally closed receiver socket producing EBADF, sender silence, and 128-byte input all reject. Processing stops at 64 bytes; each result/output is bounded |
| Timeout ownership | A deliberately hung disposable receiver is SIGKILLed and reaped; the test requires `receiver_timeout_killed_and_reaped=true` and `authorization=false` |
| Malformed controls | Separate disposable parser fixtures test both truncation flags, short/oversized headers and buffer lengths, partial integers, unknown controls, misalignment, trailing bytes, and two complete headers. These are synthetic parser inputs, not a claim that the kernel emits malformed controls |

Concurrency evidence proves overlapping userspace-bracketed kernel calls in separate live processes. It does not reveal the exact kernel instruction that installs a descriptor and is not a same-process threaded-service test. Isolation eliminates the shared descriptor table that made the original sweep dangerous. If the scheduler produces no observed overlap after eight attempts, the test fails and concurrency evidence is missing. No concurrency acceptance is inferred from sequential FD counts.

The transferred rights all duplicate a dedicated pipe writer. The sender closes its originals, the supervisor never owns a writer during receiving, and EOF is checked only after both children have been waited. EOF therefore tests actual reference release, including queued and invisible rights, independently of parser diagnostics and numeric FD counts. It does not establish a complete kernel FD inventory or authenticate any process. Native output is bounded by a 64-byte frame, at most 32 sent rights, at most 16 received visible slots, fixed report size, at most 1200 deliberate high-FD reservations, and at most 65536 concurrent-open records/100 ms; the JS process has an 8-second timeout and 64-KiB output bound.

### Remaining P0/P1 gates

| Priority | Open gate and implication |
| --- | --- |
| P0 | Peer UID/GID/xucred is a connection snapshot, not current process, executable, lifecycle, completion, or proof-of-origin authentication. Claimed UID, shared descriptors and same-UID clients never grant trust |
| P0 | No separate protected supervisor/writer OS principal, mutually authenticated endpoint, protected binaries/configuration or reviewed impersonation/debug/signal/inheritance controls exist |
| P0 | No authoritative lifecycle proof store, durable anti-replay/rollback anchor, crash-recovery authority or trusted atomic conditional deletion exists. `MacOSTrustedTransport` and `RegistryWriterCandidate` retain `TRUSTED_VERIFIER_UNAVAILABLE`; restart `automaticDeletion` stays false |
| P1 | Pathname `fchmodat`/`unlinkat` identity checks retain TOCTOU windows, including first post-bind lookup. Same-UID malicious replacement is not prevented; socketpair evidence cannot validate pathname safety |
| P1 | Independent MBA host rerun of the exact revised source, original eight tests, expanded native suite, full MCP suite, and OAuth suite remains required. Historical 8/8, 83/83 and 20/20 results apply to the older source only |
| P1 | This fixture is not a production process supervisor: it assumes a controlled launcher, no other waiters/threads, stdio plus its explicitly owned handles, and bounded test load. Production inheritance, admission/DoS limits, full Darwin version coverage, interrupted/failed teardown and cross-principal behavior remain unverified. It must never be embedded into the MCP process |

### Current verification record

Final commands, counts, exact source references and fingerprints for the final run are recorded below. No blocked bind/listen check is disabled or converted into a pass. KB reuse retrieval was unavailable under the current never-approval policy; the routed investigation/architecture/verification module files were absent. Local source and explicit task constraints governed this candidate.

| Check on the current candidate | Verified result |
| --- | --- |
| `clang -Wall -Wextra -Werror mcp/native/peercred_probe.c -o <temporary-binary>` and strict `-fsyntax-only` | PASS, no diagnostics; actual Darwin arm64 build |
| `node --check mcp/test/native-peercred.test.js` | PASS |
| `node --test --test-name-pattern='Golden\|control parser\|native source' mcp/test/native-peercred.test.js` | PASS **24/24**, zero failures/skips; includes installed FD 1101 and measured concurrent syscall overlap |
| Native cases in final complete MCP execution | **26 passed / 32 total**, six failed at pathname `bind: Operation not permitted`; original eight cases are **2 passed / 6 blocked**, not an 8/8 pass |
| `npm test --prefix mcp` | **107 total: 98 passed, 8 failed, 1 cancelled**, zero skipped. Includes original 83 plus 24 new cases; not a whole-suite pass |
| `npm test --prefix mcp-auth` | **20 total: 15 passed, 5 failed**, zero skipped; every failure reports `listen EPERM` (one TCP loopback, four UDS) |
| Trusted-candidate and restart-deletion regression cases in full MCP run | PASS: spoofed identities still cannot authorize a channel; forged keys/signatures/replays never authorize restart deletion |
| Worktree/authorization preservation | HEAD still `4f62bbb5`; tracked diff empty; original untracked file inventory retained; seven `.mba-*.md` prompt SHA-256 values unchanged |

The eight MCP failures consist of the six native pathname binds plus SDK/terminal tests reporting missing disposable tmux sockets during `kill-server` cleanup. The HTTP test is cancelled with `Promise resolution is still pending but the event loop has already resolved`; its child suppresses stderr and its finally block waits for an already-exited child, so the exact startup cause is not independently proven by that test's output. Socket restrictions are consistent with the other observations, but are not substituted for direct evidence. These existing integration fixtures do not import the C probe. Their tmux/HTTP failures remain unresolved host-verification gaps; no unrelated runtime/test changes were made to mask them.

The final new tests also passed as part of the complete 107-case execution. Earlier exploratory runs found Darwin returning the input `MSG_DONTWAIT` flag and not setting `MSG_CTRUNC` when given a zero-size control buffer. The candidate now masks only that known echoed input bit and uses a nonzero header-sized buffer for the one-FD truncation fixture. Both fixes were rerun; zero-buffer behavior is not used as truncation evidence.

Exact source evidence (line numbers for the fingerprints below):

| Invariant | Source |
| --- | --- |
| Bounds/alignment/full validation, visible-handle-only close, no truncated inventory | `mcp/native/peercred_probe.c:167` (`inspect_control`) |
| Synthetic malformed/control-message matrix | `mcp/native/peercred_probe.c:213` (`control_fixture`) |
| Fresh per-receive msghdr/control, explicit returned-flag handling, no error retry | `mcp/native/peercred_probe.c:258` (`recv_checked`) |
| Own-child bounded wait/kill, no signal after successful reap | `mcp/native/peercred_probe.c:282` (`reap_child`); SIGCHLD disposition at line 495 |
| Bounded disposable receiver, prefix barrier, targeted FD 1101 observation and unconditional process exit | `mcp/native/peercred_probe.c:297` (`receiver`); `_exit` at line 346 |
| Explicit inherited-handle closure and parent accepted-handle closure | `mcp/native/peercred_probe.c:424` |
| Real concurrent open intervals and write/close exercise | `mcp/native/peercred_probe.c:439` |
| Reap before pipe EOF and independent parent/concurrent FD postconditions | `mcp/native/peercred_probe.c:451` |
| Pathname TOCTOU retained | `mcp/native/peercred_probe.c:48` (`unlinkat`), line 541 (`fchmodat`) |
| Original eight tests retained; new Golden lifetime/ancillary cases | `mcp/test/native-peercred.test.js:24`, line 83 onward |
| Fail-closed trusted boundary unchanged | `mcp/registry-writer-transport.js:8`, `mcp/registry-writer-service.js:9`, `mcp/restart-retention.js:9` |

SHA-256 of the final native source and JS tests:

```text
d460ca15f04862f01a8e8a8d3d7f8c6661504498e85542d76ed4170580a41277  mcp/native/peercred_probe.c
533d19b578fcd8ea221d8b64d6cd2fd7170e35209b885b5d9acc071fbebf3f42  mcp/test/native-peercred.test.js
```

Independent MBA host acceptance must first confirm those fingerprints, compile strictly, then run `node --test mcp/test/native-peercred.test.js` (expected **32/32**, including the original eight), `npm test --prefix mcp` (expected **107/107**), and `npm test --prefix mcp-auth` (expected **20/20**). The high-FD case must not be skipped and concurrency must observe real overlap for complete acceptance. Host acceptance of this test-only candidate does not close the production P0/P1 gates or permit trusted writing/deletion, runtime integration, merge or deployment.


### Independent MBA-Terminal host acceptance — final candidate (2026-11-06)

The manager independently verified the exact candidate source fingerprints after Codex exited:

- C helper: `d460ca15f04862f01a8e8a8d3d7f8c6661504498e85542d76ed4170580a41277`
- Native tests: `533d19b578fcd8ea221d8b64d6cd2fd7170e35209b885b5d9acc071fbebf3f42`
- `clang -Wall -Wextra -Werror -fsyntax-only mcp/native/peercred_probe.c`: exit 0
- `node --check mcp/test/native-peercred.test.js` and `git diff --check`: exit 0
- Actual MBA-Terminal native `node --test test/native-peercred.test.js`: **32/32 passed, 0 skipped, exit 0**, independently run again after Codex stopped
- Actual MBA-Terminal MCP `npm test`: **107/107 passed, 0 skipped, exit 0**
- Actual MBA-Terminal OAuth `npm test`: **20/20 passed, 0 skipped, exit 0**
- Two additional independent native-only runs before final source freeze: **32/32 passed each, 0 skipped**, including actual high-number FD >1023 and measured concurrent overlap

Codex's separate sandbox runs had Unix-socket bind/listen EPERM and tmux restrictions; those failures have not been reclassified as successes. Only the independently observed MBA-Terminal execution host is reported as passing. The 32 native tests are included within the 107 MCP total (do not count them twice). This acceptance is solely for the isolated proof-of-mechanism candidate: not a trusted production ancillary receiver, not independent cross-UID OS authority, not protected lifecycle supervision or proof store, and not a fix for pathname TOCTOU or atomic deletion. The writer/transport remain fail closed and automatic restart deletion remains off.
