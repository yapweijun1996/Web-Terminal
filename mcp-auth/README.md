# Shared terminal remote authorization

This gateway authorizes remote MCP clients to use the private `../mcp` server. Browser and MCP tools refer to the same dedicated tmux server and workspace. Source changes do not deploy services.

## Boundary

Use two private Unix sockets in an owned private directory. The public socket serves OAuth discovery, dynamic registration, authorization redirects, token exchange, revocation and bearer-protected `/mcp`. The separate approval socket independently verifies Cloudflare Access JWT signature, issuer, application audience and expiry. Optional `ACCESS_OWNER_EMAIL` further narrows the existing Access policy. Without it, the existing Access application's approved browser identities are reused. Host or email headers alone never establish identity.

Public authorization redirects to the existing Access-protected terminal host. An explicit consent form names the client and callback. Only a same-origin POST with the consent nonce issues a code. Codes expire in one minute and bind exact client, redirect, resource and S256 challenge. The consent duration defaults to 30 days and offers 1 hour, 1 day, 7 days, 30 days, 90 days, 180 days or 365 days. The backend rejects other or duplicate values. A grant starts at consent and has an absolute expiry, so delayed token exchange and restart never extend it. Tokens are stored only as domain-separated keyed HMAC digests. No refresh tokens: authorize again after expiry. POST `/oauth/revoke` with form field `token` revokes a bearer immediately.

## Configuration

Run `npm ci --ignore-scripts`, then `node server.mjs` with private service environment:

```text
MCP_PUBLIC_URL=https://terminal-mcp.example.com/mcp
MCP_APPROVAL_URL=https://terminal.example.com/__terminal_mcp/authorize
MCP_AUTH_SOCKET=/absolute/private/runtime/auth.sock
MCP_APPROVAL_SOCKET=/absolute/private/runtime/approval.sock
MCP_UPSTREAM_SOCKET=/absolute/private/runtime/mcp.sock
MCP_STATE_DIR=/absolute/private/state
MCP_STATE_KEY_FILE=/absolute/private/keys/authorization.key
ACCESS_ISSUER=https://your-team.cloudflareaccess.com
ACCESS_AUDIENCE=<existing terminal application audience>
MCP_REDIRECT_URIS=["https://chatgpt.com/connector_platform_oauth_redirect","https://claude.ai/api/mcp/auth_callback"]
```

`ACCESS_OWNER_EMAIL` is optional. Actual deployment values belong in private service configuration outside the repository. Never print bearer tokens or Access JWTs. Existing sockets are refused; graceful shutdown removes owned sockets. Inspect stale paths before removal after a crash.

Route the MCP hostname to the public socket. Route the exact approval path on the terminal hostname to the approval socket before the terminal catch-all, preserving existing origin-side Access validation. The MCP hostname uses application OAuth and must not require interactive Access login for metadata/token/MCP requests. Preserve terminal/upload protection. Back up and validate ingress before changing it. Do not restart ttyd or tmux.

## Durable connections and revocation

Create separate owned mode-0700 state and key directories before launch. Production requires both state paths. A new store creates a random 32-byte mode-0600 master key outside the state directory; keep the key out of state snapshots. Grant metadata and DCR registrations persist as an integrity-authenticated JSON envelope written through exclusive temporary files, fsync and atomic rename. Store contents contain client names, public client identifiers, grant timing and keyed token digests, never raw bearer tokens or authorization codes. Issuer and resource are bound to the envelope; reuse under a different public URL fails closed. A missing/wrong key, tampering, unsafe permissions or symlinks prevents startup. Persistence failures disable further authorization instead of falling back to memory.

A single writer lock rejects an active or ambiguous writer. A mode-restricted regular lock containing a demonstrably dead PID can be recovered under an exclusive recovery gate after inode verification. Live/reused PIDs, permission errors, malformed locks and interrupted recovery gates require operator inspection. Never blindly remove a live lock. Graceful shutdown releases the lock. Owner-approved DCR clients remain registered until the private state is intentionally reset. Unapproved registrations expire after 24 hours and are evicted oldest-first when the 100-client capacity is reached; anonymous registration cannot evict approved clients. If all 100 clients are approved, further registration is refused until an operator reviews/reset unused client registrations. Authorization also checks the current callback allowlist. Up to 1,000 unexpired grants are retained.

The protected approval URL with `?view=connections` lists app name, consent/expiry time and connection status. A verified Access session, same-origin POST and one-use CSRF nonce are required to revoke by opaque grant ID. Revocation persists across restarts. `pending` means consent was granted but the app has not exchanged its code. Public OAuth token revocation remains available. No management action exposes raw credentials.

On upgrading from the previous in-memory gateway, existing registrations, pending requests and bearer tokens cannot be migrated: reconnect the app once. Thereafter registrations and issued grants survive gateway restart, while unfinished authorization requests/codes remain memory-only and must be restarted. Restart is no longer a revocation mechanism; use connected-app management. Restoring an old authenticated state snapshot can restore grants revoked after that snapshot, so backup restoration requires owner review and may require grant reset. Master key loss invalidates the store; key rotation currently requires revoking/resetting grants and reconnecting clients rather than automatic key overlap.

Official callback sources checked 2026-11-05:

- [OpenAI](https://developers.openai.com/plugins/build/auth): `https://chatgpt.com/connector_platform_oauth_redirect`.
- [Anthropic](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers): `https://claude.ai/api/mcp/auth_callback`.
- [MCP authorization](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx).

The authorization metadata advertises RFC 9207 issuer identification, and both approval and denial redirects return the exact issuer as `iss`. ChatGPT then uses its stable callback rather than a callback-ID-specific URI. Allowlist callbacks exactly; never wildcard. Clients must pass `resource` equal to `MCP_PUBLIC_URL` during authorization and exchange.

## Verification

Run `npm test`. Disposable fixtures cover OAuth consent and negative boundaries, signed Access JWT verification, and bearer proxy isolation. They do not touch live terminals. Production acceptance additionally requires a real user sign-in and connector approval, then same-window listing and harmless input in a disposable visible terminal. Fixture success does not prove actual ChatGPT/Claude UI behavior or production identity policy. Revocation rejects subsequent requests; already forwarded input cannot be undone.
