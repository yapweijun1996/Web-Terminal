# Phase 3B: security checkpoint

**P0 OPEN. The collaborative terminal is not available or release-ready.**
`runtime/collaboration-serve.sh` remains fail-closed. No authenticated HTTP
Upgrade, ttyd WebSocket proxy, browser lease integration, protected tmux server,
or collaboration workspace exists in this change. Consequently MCP and upload
have no protected workspace to connect to; their legacy paths are not themselves
restricted by a new boundary. Do not connect either path, legacy ttyd, or any
other direct tmux writer to a future protected workspace without enforcement.

## Bounded component

`runtime/gateway/test-credential.js` is a test-only Ed25519 credential verifier;
no listener invokes it. Its explicit issuer, audience, public key, and subject
policy are injected by a fixture. It requires a short-lived, canonical compact
JWT with exact claims and maps the verified subject to a copied server-side
policy. It does not implement Cloudflare Access, browser cookie handling,
revocation, an Upgrade handler, or connection-expiry enforcement. It must not
be used as a production-access bypass or treated as a complete JWT profile.

## Boundary and evidence

The installed executable reports ttyd 1.7.7. An isolated real ttyd `/bin/cat`
fixture accepted the client's JSON handshake and binary `0` input prefix and
returned the marker. This probe does not establish resize, pause, resume,
fragmentation, authorization, or gateway behavior. Sandboxed ttyd and tmux
attempts failed to create Unix sockets; with isolated local socket permissions,
the ttyd probe and existing disposable tmux integration test passed. No live
service, existing browser, production endpoint, or live tmux was used.

The broker checks the connection and lease around target verification. Its
executor contract requires an additional atomic tmux target check. Forwarding a
raw ttyd frame to an attached tmux client does not supply that guarantee and
can target a changed pane or session. A fixed pane identity also needs protection
against server/PID reuse. Origin checking is not identity verification; the
existing Cloudflare configuration is historical evidence, not a verified
origin-side authentication contract. Same-UID local processes remain trusted.

## Required work before opening the launcher

1. Establish an independently reviewed, fixed-pane transport design that fences
   target replacement and in-flight input, prevents client navigation to other
   panes, and isolates the tmux server and raw ttyd socket from legacy paths.
2. Select and pin a maintained WebSocket implementation; validate Upgrade
   credentials before any upstream connection, bind server-side policy and
   broker lease to each connection, and enforce expiry, frame/control policy,
   bounded queues, fragmentation, close and backpressure.
3. In an appropriately permitted disposable environment, verify the remaining
   ttyd protocol and exercise two independently authenticated clients, invalid
   upgrades, watcher output and non-mutation, takeover, disconnect fencing,
   controls, malformed frames, backpressure and inaccessible raw routes.
   Independently establish absence of every externally reachable unmediated
   route. MCP and upload must remain isolated until separately migrated.

This checkpoint does not authorize deployment or establish full product readiness.
