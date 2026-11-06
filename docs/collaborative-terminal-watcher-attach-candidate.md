# Watcher-only attach candidate

Status: **experimental isolated subset, not deployable**. The real host two-client test passed locally; independent manager replay and production acceptance remain outstanding. This does not change `runtime/attach.sh`, `runtime/serve.sh`, the existing launcher, or a live server.

## Boundary and responsibilities

`runtime/candidates/watcher-owner.js` creates and owns a new, randomly named dedicated tmux server. It requires an owner-only directory and rejects a pre-existing owner lock. It records server PID, session, window and pane IDs, the effective and local `window-size` values, then applies `manual` to the exact window. It checks the identity and local manual option on each lease operation. Its in-memory lease set represents a trusted caller's watcher processes; the caller must acquire before starting ttyd, terminate and wait for that ttyd before release, and serialize all calls. The E2E does this. This is **not** an implementation of a network attach service: the module does not launch or track watchers, authenticate clients, supervise their lifetime, or prove leases match live processes. No client may supply an identity, lease or trusted resize command. Only the same-UID trusted test process may access the private tmux and ttyd Unix sockets. Same UID is the trust boundary, not protection against a hostile same-UID process.

Manual sizing is per window. Prior experiments observed the ttyd handshake resize an 80x24 pane to 101x36 despite read-only input, and manual sizing preserved the pane. Manual prevents client-driven window resizing but also means ordinary automatic window sizing is disabled while active. A separate trusted sizing owner must perform explicit resize; the test uses `tmux resize-window` as that trusted owner. It does not globally override resize.

## State and restoration

- `NEW`: private lock acquired. The owner refuses an existing named server and creates a fresh one. Initialization failures leave the lock and any changed state for trusted reconciliation; no automatic retry or rollback is assumed.
- `ACTIVE`: recorded identity and manual option must still match. A random in-memory token is acquired for each watcher. Attach failure requires the caller to prove the ttyd process never started or has exited before releasing its token. Disconnect similarly requires the process to have exited. If other tokens remain, `close` refuses to restore.
- `RESTORED`: after all tokens are released and identity/manual checks pass, the exact former local state is restored: restore its explicit value, or unset the local option if it was inherited. Readback must match before the lock is removed. A second close fails.
- `AMBIGUOUS`: identity, option, or absence check fails, or restore readback fails. No further lease or restore is allowed. The lock remains; a trusted operator must inspect and reconcile. If an external owner has changed the option, the candidate leaves that option alone; it cannot guarantee manual remains in effect after an external change.
- Crash/restart: the persistent lock blocks a new owner, but leases are memory-only and child lifecycle is not durably recorded. Never infer zero watchers or restore automatically after crash. This is **P0 for production**. The test simulates a stale lock, not a real SIGKILL/restart recovery. Initialization/restore interruption can also leave an ambiguous state.

The exclusive owner contract is essential: tmux has no compare-and-swap here. A same-UID actor can change and change back an option (ABA), or race verification and restoration; such changes are undetectable. `manual` readback and a lock are not proof of exclusive ownership. A production implementation needs enforceable single-writer fencing, durable lifecycle and recovery, and verified process-to-lease binding. Failure to verify a safe restoration is a stop condition, not permission to unset an option.

## Reproduction and measured evidence

From this repository on the execution host with Node, ttyd 1.7.7 and tmux 3.6a installed:

```sh
node --check runtime/candidates/watcher-owner.js
node --check tests/spikes/watcher-only-two-client.e2e.js
node --test tests/input-broker.test.js tests/collaboration-guard.test.js
node tests/spikes/watcher-only-two-client.e2e.js
```

The test creates a 0700 `/tmp/mba-spike-*` directory, a random private server, two separate ttyd processes and two WebSockets; it never uses the production socket. On the MBA-Terminal execution host the final command exited 0: 10 named checks and temporary-directory cleanup passed. Both handshakes (101x37 and 132x45) retained 80x24; both saw a broker-authorized marker. Text, Enter, bracketed paste, control and resize attempts left captured pane, geometry and process unchanged. Trusted resize reached 90x30; first disconnect retained manual, reconnect received output without resize, and last disconnect restored the initially inherited local option. A separate `-W` control accepted input. Duplicate lock, unsafe directory, and externally changed option were rejected. This test used the same UID and in-memory trusted identities; it did not test authentication.

`node --check` passed for both new files. The targeted four broker/launcher tests passed in the sandbox. A broader `node --test tests/*.test.js` run had failures in the sandbox, including missing `client/node_modules/typescript` and private-socket/launcher-dependent tests; it is not a passing regression suite. Initial sandbox real test could not connect to its disposable tmux socket. Final host output is in `/tmp/mba-watcher-attach-v1-report.md`; independent manager replay is **UNKNOWN**. Cleanup asserts directory removal, but does not independently audit the host process table or prove all orphan processes are gone.

## Production gates still open

P0: real authentication and authorization; gateway/MCP/upload paths and bypass coverage; direct tmux socket isolation from untrusted clients; durable crash recovery and process-bound concurrent leases; fencing against external/ABA option changes; attach failure and interrupted restore recovery; independent acceptance and complete regression validation. P1: explicit trusted resize policy and operational reconciliation tooling. No result here establishes a complete collaboration release.
