# Watcher owner recovery candidate v2

Status: **PARTIAL_ACCEPTED; candidate only, not production-ready; do not deploy.** This is a quarantine experiment, not automatic crash recovery. The original owner and two-client Golden test remain unchanged. No production integration or network authentication is included.

## Design and boundaries

`runtime/candidates/watcher-owner-durable.js` wraps the existing owner. It creates the existing exclusive lock, syncs its parent directory, and writes a journal inside the lock using an exclusive random temporary file, file fsync, rename, and directory fsync. It requires a 0700 owner directory and checks the lock identity, restrictive permissions, regular journal file, and exact in-memory journal bytes before updates. Journal lifecycle/generation and the lock's device/inode, server/session/window/pane identity, original and manual option, owner PID, and watcher lease ID hashes and PIDs are recorded. Process start identities are currently **unknown** (null). The generation increases for candidate writes, but is not an authenticated monotonic counter. Tokens are local grants, not OS ownership or proof of process binding.

A stale lock is never automatically removed. Recovery and lease reentry always return `NEEDS_OPERATOR`, including for valid journals; `close()` never restores the setting, even when there are no recorded leases. The journal's recovery decision is always `NEEDS_OPERATOR`. Option drift observed by the active owner makes its state `AMBIGUOUS`. The candidate does not provide an operator reconciliation command: any eventual reconciliation must be performed by an independently trusted supervisor/operator after independently establishing process and watcher liveness, server identity, and desired state. Do not infer authority from the journal or delete the lock solely because a PID appears dead.

The inherited owner sets `manual` at start. This candidate **does not restore it**; an interrupted start may also leave an incomplete record or an existing server. Its recorded `STARTING` state and retained lock deliberately require investigation. A journal write failure likewise does not authorize retry or restore. fsync errors fail the operation; actual power-loss durability depends on the filesystem and is unverified.

## P0 release block

A same-UID untrusted process can edit tmux, replace or rewrite files and locks, reproduce journal bytes, race checks and rename, and perform an undetectable option ABA. Lock directories, random IDs, generation numbers, checks and atomic rename do **not** provide secure fencing or proof of exclusive OS ownership. The cooperative lock excludes ordinary contenders only while it remains intact; it does not establish that two hostile same-UID processes cannot both act. Use a separate OS principal or a privileged owner service with enforced access controls and an independently verified fencing and process-identity design before claiming anti-ABA or crash recovery. The current code is not a production security boundary.

## Proof matrix

| Case | Evidence and limit |
| --- | --- |
| Concurrent/stale lock and recovered lease | File-level test passes for cooperative instances and unconditional recovery denial; real SIGKILL replay is unverified here. |
| Invalid, truncated, symlinked, changed journal or generation | File-level tests pass against the original in-memory snapshot; same-UID forgery and TOCTOU are not prevented. |
| Interrupted restore | Synthetic `RESTORING` journal is denied; no actual restore is implemented, so a real mid-restore crash is not tested. |
| Live watcher | Candidate checks its in-memory lease set and never restores even with zero leases; real live-watcher test did not reach its assertion in this sandbox. No independent watcher-liveness proof exists. |
| External largest / ABA | Real tmux scenario is written but did not reach its assertions; option ABA is explicitly not detectable or guaranteed. Automatic restore is denied. |
| Crash, replay, cleanup | Isolated test uses one disposable `/tmp` socket namespace and SIGKILL, and cleanup in `finally`; sandbox could not establish a usable server, so crash/replay assertions are NOT_RUN. No claim of independent verification. |
| Original two-client 10/10 | Original file untouched; sandbox execution exited 2 before checks because its disposable tmux server disappeared. 10/10 is NOT verified in this run. |

## Reproduction and outcomes

From the repository root on a host that permits isolated tmux sockets and has Node, tmux and ttyd:

```sh
node --test tests/spikes/watcher-owner-recovery.test.js
node tests/spikes/watcher-only-two-client.e2e.js
```

On the Codex sandbox, the focused file-level selection passed 4/4:

```sh
node --test --test-name-pattern='stale|corrupt|interrupted|unsafe' tests/spikes/watcher-owner-recovery.test.js
```

The complete recovery command exited 1: four file-level tests passed, two real-tmux tests failed before their assertions with `error connecting ... (No such file or directory)` after server startup. The original Golden command exited 2 at the same startup stage, before its 10 checks, and reported temporary-directory cleanup. This observation alone does not establish the OS-level cause. Host execution by the manager remains required; no host result is implied.
