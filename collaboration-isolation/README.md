# macOS socket isolation candidate

Status: **OS_ENFORCEMENT_PREPARED / DUAL_PRINCIPAL_NOT_VERIFIED**. Mock only,
not production safe. No production imports or runtime integration.

Run on the real macOS host (Node, system clang and lsof; no installs):

```sh
cd /Users/yapweijun/DevelopmentWorktrees/web-terminal-collab-20261106
node --test tests/collaboration-isolation.test.js
```

The suite first compiles separate `supervisor` and one-shot `diagnostic` binaries
into a disposable 0700 directory in `/private/tmp`, then removes its processes,
sockets and binaries. On the Codex sandbox bind may fail with EPERM: run the
same command through MBA `terminal_exec`, outside tmux. Never turn a bind failure
into a passing/skipped socket test.

Manual diagnostic in a scratch directory, in your own login only:

```sh
TASK_BUILD=$(mktemp -d /private/tmp/mba-iso-build.XXXXXX)
clang -std=c11 -Wall -Wextra -Werror -O2 collaboration-isolation/diagnostic.c collaboration-isolation/socket.c -o "$TASK_BUILD/diagnostic"
TASK_SOCKET=$(mktemp -d /private/tmp/mba-iso-socket.XXXXXX)
"$TASK_BUILD/diagnostic" "$TASK_SOCKET" "$(id -u)" &
TASK_PID=$!
# Once READY is printed, from this session within three seconds:
node collaboration-isolation/probe.js ping "$TASK_SOCKET/gateway.sock"
wait "$TASK_PID"
rm "$TASK_BUILD/diagnostic"
rmdir "$TASK_BUILD" "$TASK_SOCKET"
```

To compile enforcement instead, replace `diagnostic.c` with `supervisor.c`.
Its arguments are `ABSOLUTE_EMPTY_0700_DIRECTORY SEPARATE_CLIENT_UID`.
The binary always rejects a client UID equal to its effective UID, UID 0,
set-ID startup and unknown flags. It never switches identity. Changing an
expected UID is **not** testing a second UID. Diagnostic cannot execute commands
or proxy writable terminals either.

Only `PING ` + 32 lowercase hex nonce bytes + newline + write EOF is accepted.
The response reports the actual kernel peer UID/GID, never a claimed identity.
The nonce is correlation, not authentication or durable anti-replay. Each
accepted connection calls `getpeereid` before any frame operation. Protocol and
permission failures return no data. Diagnostic exits after one connection;
enforcement after at most 16, or an idle/state error. Idle accept deadline is
3 seconds, entire request/response deadline 1 second, backlog 4, frame limit
38 bytes plus one overflow byte. No TCP sockets or child command execution.

Directories must have no extended ACL and exact mode 0700, correct owner, no
symlink in any component, and be empty. Ancestors must be root/S-owned with no
extended ACL and no group/world writes, except root-owned sticky ancestors
(e.g. `/private/tmp`). Socket mode is 0600 before `listen`. Successful extended
stat plus `filesec_query_property` distinguishes absent ACL from lookup failure.
All extended ACLs (including empty ones) are rejected; unknown permissions deny.
Descriptors pin the directory; a lock prevents duplicate listeners. Existing
or stale socket paths are never reused/unlinked. SIGTERM/SIGINT clean only the
created inode; SIGKILL intentionally leaves a stale socket that refuses restart.

See [the ownership contract, P0 gates and authorized manual staging checklist](../docs/collaboration-isolation-candidate.md).
