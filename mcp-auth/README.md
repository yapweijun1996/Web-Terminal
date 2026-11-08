# Shared terminal remote authorization

This gateway authorizes remote MCP clients to use the private `../mcp` server. Browser and MCP tools refer to the same dedicated tmux server and workspace. Source changes do not deploy services.

## Boundary

Use two private Unix sockets in an owned private directory. The public socket serves OAuth discovery, dynamic registration, authorization redirects, token exchange, revocation and bearer-protected `/mcp`. The separate approval socket independently verifies Cloudflare Access JWT signature, issuer, application audience and expiry. Optional `ACCESS_OWNER_EMAIL` further narrows the existing Access policy. Without it, the existing Access application's approved browser identities are reused. Host or email headers alone never establish identity.

Public authorization redirects to the existing Access-protected terminal host. An explicit consent form names the client and callback. Only a same-origin POST with the consent nonce issues a code. Codes expire in one minute and bind exact client, redirect, resource and S256 challenge. The consent duration defaults to 1 month (30 days) and offers exactly 1 hour, 1 day, 1 week (7 days), 1 month (30 days) or 1 year (365 days). The backend rejects other or duplicate values. A grant starts at consent and has an absolute expiry, so delayed token exchange and restart never extend it. Tokens are stored only as domain-separated keyed HMAC digests. No refresh tokens: authorize again after expiry. POST `/oauth/revoke` with form field `token` revokes a bearer immediately.

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

`MCP_GRANT_MAX_SECONDS` optionally lowers the deployment's maximum grant duration to one of the supported duration values. Both the displayed options and backend validation enforce it. The default becomes the longest permitted option when the normal 30-day default exceeds the limit. The Linux deployment uses `31536000`, allowing the five standard options with a 30-day default and one-year maximum.

Route the MCP hostname to the public socket. Route the exact approval path on the terminal hostname to the approval socket before the terminal catch-all, preserving existing origin-side Access validation. The MCP hostname uses application OAuth and must not require interactive Access login for metadata/token/MCP requests. Preserve terminal/upload protection. Back up and validate ingress before changing it. Do not restart ttyd or tmux.

## MCP request-body authorization boundary

The gateway authenticates a bearer before collecting an MCP request body, then
checks the same token again immediately before opening the upstream connection.
A grant revoked or expired while the body is being uploaded receives `401` with
the normal resource-metadata challenge and sends no bytes upstream. The absolute
grant expiry is unchanged. Requests already forwarded and commands already
started cannot be retracted by this check.

MCP bodies are limited to 1 MiB and a **total** five-second upload deadline; each
chunk does not extend the deadline. Timeout returns a sanitized `408`, oversized
content returns `413`, and an aborted upload is discarded. No partial body is
forwarded. `MCP_REQUEST_BODY_TIMEOUT_MS` may set the server-owned deadline to an
integer from 1 to 30000 milliseconds; invalid configuration fails startup. The
limit does not alter the existing 30-day default/365-day maximum grant policy,
owner verification, PKCE, callbacks, or durable authorization storage.

## Optional coordinated-input adapter

Set `MCP_COLLABORATION_SOCKET` to the absolute private coordinator socket only
when the MCP server and UI are configured for coordinated input. After the final
bearer check, each text/key RPC obtains a short-lived single-use admission bound
to the server-owned grant ID/absolute expiry and the exact operation digest. The
gateway rechecks that same grant after admission and forwards only the internally
minted `x-web-terminal-admission`; caller-supplied admission/owner headers and raw
bearers are never forwarded. Coordinator refusal or unavailability sends no
mutation upstream and does not fall back to direct input. Read-only RPC does not
need an admission. Token and protected owner-management revocation notify the
coordinator without changing durable grant policy; already-dispatched bytes or
commands cannot be undone. The coordinator independently bounds admission TTL
and enforces grant revocation/expiry before delivery.

For execute-time revocation authority, configure `MCP_GRANT_VERIFY_SOCKET` in
the gateway's private owned runtime directory and `TERMINAL_GRANT_VERIFY_SOCKET`
on the UI coordinator to that same socket. Only this new private listener serves
`POST /v1/grant {grantId}`; it returns a live `{active:true,expires}` projection or
`{active:false}` after pruning, never a bearer or owner claim. It is absent from
the public/approval routes, rejects browser Origin, and uses the existing private
socket ownership/mode checks. The coordinator must query it before actual
mutation delivery; an unavailable verifier never permits cached authority. This
closes the stale-admission window even if a revoke notification is lost.

In coordinated mode, durable token revocation and confirmed input cancellation
are different outcomes. A missing/failed drain acknowledgement returns sanitized
`503 revocation_pending` after the token is already revoked. Bounded process-local
HMAC-keyed status permits retrying confirmation without storing raw tokens; an
unknown status after restart/eviction returns `revocation_status_unavailable`
rather than claiming a drain completed. Owner management displays the pending
state and a fresh one-use CSRF retry form. A successful notification/drain can
then confirm cancellation. Without a coordinator, the existing idempotent OAuth
revocation behavior is unchanged. No durable authorization state is rolled back
to make a notification succeed.

The existing exact Access-protected approval URL supports the read-only query
`?view=input-identity`. It returns only `{authorized:true, ownerId, expires}` from
the cryptographically verified Access issuer/subject/expiry; the identity is
opaque and does not expose email or JWT. A boolean-only verifier cannot supply
this identity. UI private calls forward the incoming signed Access JWT for this
check, never a claimed owner role. The UI uses `TERMINAL_OWNER_VERIFY_SOCKET` and
`TERMINAL_OWNER_VERIFY_URL` for the existing approval socket/URL. No new public
route, relaxed callback allowlist, fake owner header, or independent-OS-principal
claim is introduced. The same-UID private socket remains a trusted local adapter
boundary rather than a sandbox against processes with that OS authority.

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

The gateway advertises RFC 9207 issuer identification and returns its exact `issuer` as `iss` in both successful and denied authorization callbacks. This enables ChatGPT's stable callback URI above; without issuer identification, new ChatGPT connections use callback-specific URIs instead. See the current [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth).

For connection diagnosis, `MCP_AUTH_LOG_REQUESTS=1` enables request summaries containing only the surface, allowlisted route, normalized HTTP method and response status. Queries, request bodies, headers and identities are omitted. Logging is disabled by default.

## Verification

Run `npm test`. Disposable fixtures cover OAuth consent and negative boundaries, signed Access JWT verification, and bearer proxy isolation. They do not touch live terminals. Production acceptance additionally requires a real user sign-in and connector approval, then same-window listing and harmless input in a disposable visible terminal. Fixture success does not prove actual ChatGPT/Claude UI behavior or production identity policy. Revocation rejects subsequent requests; already forwarded input cannot be undone.

## Native browser form regression

Consent and connected-app pages use `Referrer-Policy: same-origin`. This keeps cross-origin referrers private while allowing native same-origin POST forms to send their real Origin. `no-referrer` makes native Chrome form navigation send the literal `Origin: null`, which the strict origin check correctly rejects. Do not accept null or missing origins to work around a page-policy error. Access JWT, CSRF and exact Origin checks still apply. Authenticated form verification failures show reconnect guidance; unauthorized requests remain denied.

Run the opt-in native Chrome regression with an existing Playwright installation:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node mcp-auth/browser/native-consent.e2e.cjs
```

It creates a disposable HTTPS loopback fixture with a self-signed certificate (ignored only in its isolated browser context), synthetic owner verification and no live grants or terminal access. Native Allow, Deny and Revoke button clicks use the actual gateway-rendered forms and headers, with no fetch calls or rewritten Origin headers. The old no-referrer policy is reproduced as null-Origin rejection; current same-origin pages must send the real matching Origin and succeed. Node, OpenSSL and installed Google Chrome are required; override `PLAYWRIGHT_BROWSER_CHANNEL` for another installed Playwright channel. Fixture credentials and files are removed afterward. HTTP tests also prove literal null and foreign origins remain rejected and CSRF failures cannot issue a grant. This fixture does not prove a real user's Cloudflare identity or ChatGPT callback completion.

## Cross-origin OAuth return regression

Chrome applies a consent document's `form-action` policy to its POST redirect chain. A self-only policy can accept consent and issue a code while blocking the return to ChatGPT or Claude. Consent pages now allow only self and that request's exact validated callback origin/path; directive punctuation is encoded, and query matching remains enforced by the full exact application redirect check. Management and recovery pages keep self-only form submission. Script and beacon restrictions remain unchanged.

Run `PLAYWRIGHT_MODULE=/absolute/path/to/playwright node mcp-auth/browser/cross-origin-consent.e2e.cjs`. This uses two distinct disposable HTTPS origins: a real native Chrome consent POST follows the cross-origin return, validates `iss`/`state`, exchanges its code with S256 PKCE, and initializes/lists tools through the real private MCP SDK without touching any terminal. The old self-only CSP reproduces backend success but zero callback/token exchange; a second native click shows already-handled recovery and creates no second grant.

Consumed consent requests retain a bounded five-minute in-memory tombstone containing only their original CSRF nonce and expiry. Repeated authenticated same-origin submission with that nonce receives recovery guidance without minting a new code or resending a consumed code. Pending grants without exchanged tokens expire after the same 60-second authorization-code deadline; issued grants retain their original selected expiry.
