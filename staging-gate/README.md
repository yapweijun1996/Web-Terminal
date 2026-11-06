# Prepare-only staging gate candidate

Release is blocked. This directory is an experiment, not an authorization system or a production write proxy. All process and filesystem tests use the current UID only. The candidate neither changes ACLs nor switches users.

## Authorization inventory

Run `node staging-gate/preflight.js [records.json]`. It emits numeric UID presence only and exits 1 while G0 is blocked. Local inventory is read-only and presence is never approval. Optional JSON has exactly `S` and `C` keys, each containing exactly `version`, `role`, numeric `uid`, absolute normalized `path`, `scope`, `approver`, `expiresAt`, and `distinctProof`. Role is `S` or `C`; scope is `scratch-ipc-preflight`; expiry is a future UTC timestamp. Both records must have a matching path and distinct UIDs different from the current EUID. Even a valid-shaped record is untrusted input. There is no trusted independent owner/admin attestation implementation, so `independentlyVerified` and `usable` are always false, and G0 is always BLOCKED. No JSON, flag, or claimed proof can enable the harness. The schema is a candidate for review, not a mechanism to collect real approvals.

## IPC access model

`acl-model.js` provides a strict **MODEL_ONLY** comparison of normalized abstract rights: ingress owner S mode 0700 with an explicit C search grant; socket owner S mode 0600 with an explicit C connect grant; backend owner S mode 0700 with no ACEs. This is a proposed minimum, not a verified mapping to Darwin ACL rights or effective access, socket behavior, parent traversal, supplementary groups, or ACE ordering. Any extra or missing ACE, deny, inherited flag, unexpected principal, rights including `write_acl` or `write_owner`, changed mode/owner, or backend traversal grant fails the model. An actual system must independently establish the exact full path and native semantics; parent directories, backend files, socket objects and all effective principals remain unverified. `inspectScratch` reads only metadata on a private owner scratch directory and expressly does not inspect ACLs. G1 remains PENDING. `cross-uid-harness.js` always refuses; it cannot execute, attest, or switch identities. Future implementation requires a separately reviewed independently verified owner/admin authorization channel and native boundary checks before any cross-UID test.

## Scratch fence

`ledger.js` accepts only a private, current-owner `staging-*` directory directly under the real system temp directory. Exclusive creation and fsync of a permanent fence prevents a second process taking over; a journal is created with an exclusive temporary file, fsynced, renamed, then the directory is fsynced where supported. The private output is an ordinary scratch file, not a tmux proxy. The in-memory lease is bound to the creating process and generation; every write or renewal validates the fence, strict journal, and file metadata. Existing fences, corrupted records, stale generations and symlinks fail closed. Any partially initialized fence also prevents re-entry. There is deliberately no automatic recovery or unlock API; an externally authorized operator must inspect and restore the staging environment before any future attempt. Deleting or replacing the fence is not a safe automatic recovery procedure.

This does not establish protection against a malicious process with the same UID: it can modify or remove the files, forge journal data, or bypass the library. Node path checks cannot provide race-free `openat`-style protection from a hostile same-UID actor. fsync and rename are candidate durability measures, not proof of power-loss behavior on every filesystem; directory fsync may be unsupported. No production state or backend is fenced by this experiment.

## Tests

```
node --test tests/staging-gate*.test.js
node --require ./staging-gate/no-chmod-preload.js --test tests/collaboration-gateway.test.js tests/collaboration-gateway-auth.test.js
node staging-gate/preflight.js
node staging-gate/cross-uid-harness.js
```

The original Gateway fixture calls `chmodSync` on its just-created 0700 temporary directory. The preload checks that exact path, owner, type, and mode and suppresses the redundant call without changing permissions; it rejects other calls. The existing Gateway test and implementation are untouched. The Gateway tests require local tmux 3.6a, ttyd 1.7.7 and permitted local sockets; they use a separate temporary tmux server. A sandbox that prohibits local sockets may need an already-authorized local executor. The real Gateway baseline and deliberate direct backend bypass demonstrate same-UID behavior only. The mode-denial control creates a read-only scratch file and proves only its observed same-UID open denial; its owner can change that file's permissions.
