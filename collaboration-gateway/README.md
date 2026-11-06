# Authenticated writer gateway: isolated Slice 2 candidate

**P0 RELEASE BLOCKED.** This is a functioning, headless authentication adapter
with a disposable tmux/ttyd backend. It is not production authentication,
process isolation, or a replacement for either production serve script.

Run on the Mac host with installed Node, tmux **3.6a** and ttyd **1.7.7**:

```sh
node --test tests/collaboration-gateway-auth.test.js tests/collaboration-gateway.test.js
node --test tests/input-broker.test.js tests/collaboration-mvp.test.js
```

The Golden test starts two independent WebSocket clients, verifies actual ttyd
output after Writer text plus Enter reaches a disposable `/bin/cat`, moves the
Watcher to pane 2 while Writer remains on pane 1, checks negative markers and
manual 80x24 sizing, and removes owned processes and `/tmp` fixtures. No installs,
production sockets, tmux selection changes, or external identity provider calls
are involved. Socket creation may be prohibited in the Codex sandbox; use the
authorized MBA `terminal_exec` host executor rather than changing sandbox policy.

## Ownership and authentication

- `auth.js`: trusted **test-only** Ed25519 issuer and independently configured
  public-key verifier. The gateway never owns the issuer private key, mints a
  browser-selected role, or exposes an issuance endpoint. Test callers supply
  the trusted subject/role/pane policy directly to the issuer in memory.
- `server.js`: standalone HTTP/WebSocket adapter with an injected trusted
  verifier and backend. Missing verifier prevents startup; missing identity
  prevents upgrade. The default is denial, not developer-token fallback.
- `fixture.js`: disposable backend only. Creates a fresh private directory and
  explicit `tmux -S` socket, pins the server/session/window/pane tuple, and uses
  the existing InputBroker plus guarded tmux command execution. ttyd listens
  only on Unix sockets, without `--writable`, and attaches with `-r`.
- Existing `collaboration-mvp/websocket.js` owns the bounded transport and ttyd
  stream adapter; existing `runtime/gateway/broker.js` owns serialized leases.

`startGateway({backend, verifier, leaseMs})` listens on an ephemeral loopback
port. The verifier contract is synchronous: `verifyUpgrade(req)` returns a
trusted immutable identity `{sub, role, session, panes, ...}` or throws;
`assertActive(identity)` throws if expired, revoked, unknown or otherwise
invalid. Returned `session` must equal the backend fixture ID. Roles are exactly
`writer` and `watcher`; the verifier determines scope. No forwarded header is
an identity source. A future Cloudflare Access adapter must perform external
signature/issuer/audience/session/policy verification itself and preserve active
revocation checks. No Cloudflare adapter is implemented here.

The local profile accepts canonical EdDSA JWT assertions with exact claims:
`iss, aud, sub, role, session, panes, iat, nbf, exp, nonce, cnf`. Lifetime is at
most 60 seconds, with no expiry grace. `cnf` is an Ed25519 SPKI public key bound
to the client. Nonces are one-use at upgrade, retained until expiration; the
bounded in-memory replay cache denies new upgrades when full. Nonce and session
revocation also invalidate established connections and writes. These are
process-local controls, not durable state across restart.

## Transport and protocol

Only `GET /ws` upgrades. Require exact Host and nonempty matching loopback Origin;
reject query tokens and duplicate security headers. Supply `Authorization:
Bearer <assertion>` and `X-Gateway-Proof: <base64url Ed25519 signature>`. The proof
signs the JSON array of protocol tag, method, path, Origin, WebSocket handshake
key, and SHA-256 assertion digest; `proofFor` constructs this exact value.
Stealing an assertion alone cannot create a valid handshake. Captured valid
upgrades cannot reuse its nonce; proof validation precedes nonce consumption.
The profile uses local HTTP only and must not be exposed over a public network.
Never log assertions, proof headers, private keys or lease secrets.

Native browser WebSocket cannot set these headers. Tests use an HTTP upgrade
client. Browser login, cookie/CSRF design, browser key custody and UI integration
are **not implemented**; this adapter does not claim those features.

After the `hello`, send JSON messages:

1. `{"type":"select","pane":"1"}` attaches a read-only view within signed scope.
2. `{"type":"claim"}` returns a connection-bound `lease` for Writer only.
3. `{"type":"input","lease":<proof>,"operation":{"type":"text","text":"hello"}}`
   writes literal UTF-8 bytes; send a separate `key` operation with `Enter`.
4. `renew` or `release` requires that lease. Selection/disconnect revokes it.

Only printable text up to 4096 bytes and `Enter`, `BSpace`, `Tab` are supported.
No shell commands, resize, takeover or raw ttyd frames are accepted. The
selected pane is server-owned per connection; client-supplied alternate targets
are rejected. Watchers receive output only. Peer FIN revokes authority even if
an upgraded socket remains half-open. Backend health is checked on upgrade,
on operations, in tmux's mutation queue and by a monitor.

## Bypass audit and production prerequisites

| Boundary | Candidate evidence | Remaining enforcement |
| --- | --- | --- |
| Direct ttyd TCP write | lsof asserts no ttyd TCP listener; raw Unix ttyd input and resize fail | Backend Unix sockets must be inaccessible to the untrusted OS principal |
| Gateway Upload/MCP routes | `/upload`, `/__terminal_upload`, `/mcp` and socket-like paths return 404; upgrades fail | Existing production Upload/MCP endpoints were not started, modified or probed |
| Direct tmux socket | Same-UID positive control **successfully writes** outside gateway | Distinct kernel principal and socket ACL denial must be demonstrated |
| Authenticated write path | Signed identity, holder proof, scoped lease and real output | Real external identity provider and browser integration remain absent |
| Restart/supervisor | Broker epoch fences old in-process lease proofs | Cross-UID Trusted Supervisor and durable fencing remain open |

Production architecture **requires kernel-enforced distinct untrusted client,
gateway and backend principals**, with socket/directory ACLs allowing the trusted
supervisor only the necessary access. The public gateway must not inherit a
backend UID, arbitrary tmux execution capability, or access to Upload/MCP write
sockets. A trusted supervisor must independently enforce scoped operations,
identity and durable fencing. Release requires actual two-UID (or stronger)
negative tests against tmux, ttyd and Upload/MCP, alongside a real authorized
write control. An application rejection or a mode-0700 directory shared by the
same UID is not this proof. No OS users or ACLs were changed for this slice.

`releaseStatus` deliberately remains `P0 RELEASE BLOCKED` for this candidate.
See `/tmp/mba-auth-gateway-slice2-report.md` for the actual verification outcome,
including host-executor failures and any checks still awaiting execution.
