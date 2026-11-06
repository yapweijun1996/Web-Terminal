# Bounded macOS release gate candidate

P0 release remains **BLOCKED**. G0 is BLOCKED; G1/G2/G4 are NOT_RUN. This candidate supplies a native read-only inspection slice and a production entry point that refuses startup. It does not supply approved S/C accounts, an attestation authority, a writable supervisor transport, or a production release.

## Native read-only inspection

Build on Darwin with the installed Apple SDK, without packages:

```sh
clang -std=c11 -Wall -Wextra -Werror -O2 release-gate/native-acl.c -o /private/tmp/mba-native-acl
# Usage only; S_UID and C_UID must be separately designated and different.
/private/tmp/mba-native-acl S_UID C_UID backend /absolute/authorized/scratch [previous-pin]
```

Roles are `ingress-dir`, `socket`, and `backend`. UID parsing does not look up an account or authorize using one. Tests designate the current EUID as S and use 4000000000 as a numeric policy input only; no process executes under that UID. Never substitute service accounts or interpret this as G0.

The CLI opens directories with `openat`, `O_NOFOLLOW`, `O_DIRECTORY`, and `O_CLOEXEC`; retains a bounded chain of descriptors; checks ancestor owners and modes; compares each directory binding; and rechecks extended metadata and ACL text before returning. Absolute paths must have no traversal, empty components, symlinks, controls or trailing slash. Maximum path length is 4095 bytes and maximum chain depth is 64 including root. Root-owned sticky writable ancestors such as `/private/tmp` are allowed; other writable ancestors are denied. Unexpected ancestor ACLs are denied. A socket is inspected with `lstatx_np` relative to its pinned parent, never opened as a data file. Its inspection cannot authorize a connection.

Successful `fstatx_np`/`lstatx_np` plus `filesec_query_property(FILESEC_ACL)` establishes actual ACL presence. A failed ACL lookup, including ENOENT, is never interpreted as safe absence. `filesec_get_property` retrieves the ACL. Native ACE inspection checks allow type, inheritance flags, permission masks, UUID-to-UID mapping, unexpected/group/unknown principals, security/ownership writes, and repeated/extra entries. Backend requires exact owner S, mode 0700, a directory, and **no ACL property**, including no empty extended ACL. Ingress requires an ACL; socket requires a socket object owned by S with mode 0600 and an ACL. Unknown rights, entry ordering/flags, identities and all present target ACLs ultimately fail closed. No ACL-positive configuration is accepted by this candidate.

Output contains reason codes and numeric metadata only, with no input paths, principal names, ACL text or credentials. `METADATA_ONLY / BACKEND_PRIVATE_METADATA` exits 0 as a diagnostic negative control; every other result exits 1. Every result has `productionAuthorization:false`. Optional pins contain device, inode and ctime seconds/nanoseconds. They detect replacement and metadata drift between observations; they are not capabilities. Same-UID processes can change files or replace the binary. Snapshots cannot prove future state or eliminate every concurrent same-UID race.

### SDK semantic evidence

The inspected SDK is the local `MacOSX.sdk` selected by `xcrun --show-sdk-path`. Its `usr/include/sys/acl.h` aliases `ACL_SEARCH` to `ACL_EXECUTE`; `usr/share/man/man1/chmod.1` describes directory search. `usr/include/membership.h` documents `mbr_uuid_to_id` and `ID_TYPE_UID`/`ID_TYPE_GID`. `usr/share/man/man3/acl_get_entry.3` documents return 0 for an entry and -1/EINVAL for end or invalid input; this ambiguity cannot grant access. `usr/share/man/man4/unix.4` says a connect destination must be writable and describes kernel `LOCAL_PEERCRED`, but does not establish an exact minimum ACE mask mapping for this proposed controlled ingress. No `connect` ACE is invented or mapped to `ACL_WRITE_DATA`. All present ingress/socket ACLs remain `UNKNOWN_NOT_AUTHORIZED` or a more specific denial. Actual positive and negative two-UID kernel tests remain required.

## Production entry point and diagnostics

`production-adapter.js` exports `startProductionGateway()`. It always rejects with `RELEASE_BLOCKED` **before** interpreting caller values/getters, running probes or callbacks, connecting, binding, creating sockets/listeners, or returning any write operation. Direct/inherited `backend.execute`, same UID, env flags, JSON G0 PASS, fake JWTs, forged peer metadata, supplied probe callbacks, and claimed independent attestation cannot enable it. There are no HTTP/net/Gateway fixture/tmux/ttyd/MCP imports and no upload or passthrough routes. The CLI also exits 1.

`inspectResources()` is a separate synchronous, bounded **read-only diagnostic** launcher for an operator-selected native binary, with three fixed roles, 3-second per-probe timeout and 16 KiB output bounds. Neither the caller-selected executable, its JSON, nor pins are trusted attestation. Missing/malformed probes fail closed. Diagnostics never feed an authorization success into startup. A remote writable client is deliberately not implemented before real distinct-UID peer proof, independently verified authorization and durable supervisor fencing exist. The original authenticated localhost Gateway fixture remains separate and unchanged.

## Tests and observed limits

```sh
node --test tests/release-gate*.test.js
node --test tests/input-broker.test.js tests/staging-gate*.test.js tests/collaboration-gateway-auth.test.js
node --test tests/collaboration-isolation.test.js tests/collaboration-gateway.test.js tests/collaboration-gateway-auth.test.js tests/collaboration-mvp.test.js tests/input-broker.test.js tests/staging-gate*.test.js
node --test mcp/test/*.test.js
node release-gate/production-adapter.js  # expected exit 1 / RELEASE BLOCKED
```

New Golden tests were first run RED before source existed, then GREEN on the actual Darwin host. They compile with `-Wall -Wextra -Werror`, inspect only fresh owned `/private/tmp` scratch, exercise no-ACL ingress denial, backend metadata control, wrong type/UID/owner/mode, unsafe ancestor, symlink/traversal, missing objects, replacement and ctime drift, malformed IDs, unsupported build, missing probe, disconnected socket, hostile startup options and env, and zero production listener creation. Scratch permission controls are created with their modes; the candidate never calls chmod or ACL setters. No ACL is mutated. The end-to-end flow is scratch -> real native process -> diagnostic -> denied startup. It does not execute a backend command.

Observed here: new tests **3/3 PASS**, independent Broker/staging/auth tests **13/13 PASS**. The full requested baseline is **not green** in this sandbox: native socket bind fails with errno 1; tmux scratch sockets cannot be created; MCP also lacks local `@modelcontextprotocol/sdk`. No escalation or package install was attempted. The original signed Writer Golden was attempted through the baseline command but could not reach its write step. Re-run it on the manager's authorized host using the exact baseline command. Even when it passes it is **SAME_UID positive only**, never two-principal evidence. Do not skip or relabel blocked positive tests as PASS.

ACL-positive, ACL-grant drift, live socket ACL inspection, independent attestation, actual cross-UID allow/deny, backend denial, controlled ingress, durable production fencing and mandatory Writer routing all remain **NOT_RUN/BLOCKED**. No G0 closure is inferred from numeric IDs, service membership or model flags. No account changes, ACL changes, launchd, sudo/su, user switching, owner tmux pane selection, merge, commit, push or deployment are part of this candidate.
