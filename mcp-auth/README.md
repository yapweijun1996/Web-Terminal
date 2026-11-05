# Shared terminal remote authorization

This gateway authorizes remote MCP clients to use the private `../mcp` server. Browser and MCP tools refer to the same dedicated tmux server and workspace. Source changes do not deploy services.

## Boundary

Use two private Unix sockets in an owned private directory. The public socket serves OAuth discovery, dynamic registration, authorization redirects, token exchange, revocation and bearer-protected `/mcp`. The separate approval socket independently verifies Cloudflare Access JWT signature, issuer, application audience and expiry. Optional `ACCESS_OWNER_EMAIL` further narrows the existing Access policy. Without it, the existing Access application's approved browser identities are reused. Host or email headers alone never establish identity.

Public authorization redirects to the existing Access-protected terminal host. An explicit consent form names the client and callback. Only a same-origin POST with the consent nonce issues a code. Codes expire in one minute and bind exact client, redirect, resource and S256 challenge. Bearers expire in one hour and are stored as hashes. Restart revokes all in-memory grants and registrations. No refresh tokens: authorize again after expiry. POST `/oauth/revoke` with form field `token` revokes a bearer immediately.

## Configuration

Run `npm ci --ignore-scripts`, then `node server.mjs` with private service environment:

```text
MCP_PUBLIC_URL=https://terminal-mcp.example.com/mcp
MCP_APPROVAL_URL=https://terminal.example.com/__terminal_mcp/authorize
MCP_AUTH_SOCKET=/absolute/private/runtime/auth.sock
MCP_APPROVAL_SOCKET=/absolute/private/runtime/approval.sock
MCP_UPSTREAM_SOCKET=/absolute/private/runtime/mcp.sock
ACCESS_ISSUER=https://your-team.cloudflareaccess.com
ACCESS_AUDIENCE=<existing terminal application audience>
MCP_REDIRECT_URIS=["https://chatgpt.com/connector_platform_oauth_redirect","https://claude.ai/api/mcp/auth_callback"]
```

`ACCESS_OWNER_EMAIL` is optional. Actual deployment values belong in private service configuration outside the repository. Never print bearer tokens or Access JWTs. Existing sockets are refused; graceful shutdown removes owned sockets. Inspect stale paths before removal after a crash.

Route the MCP hostname to the public socket. Route the exact approval path on the terminal hostname to the approval socket before the terminal catch-all, preserving existing origin-side Access validation. The MCP hostname uses application OAuth and must not require interactive Access login for metadata/token/MCP requests. Preserve terminal/upload protection. Back up and validate ingress before changing it. Do not restart ttyd or tmux.

Official callback sources checked 2026-11-05:

- [OpenAI](https://developers.openai.com/plugins/build/auth): `https://chatgpt.com/connector_platform_oauth_redirect`.
- [Anthropic](https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers): `https://claude.ai/api/mcp/auth_callback`.
- [MCP authorization](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx).

Allowlist callbacks exactly; never wildcard. Clients must pass `resource` equal to `MCP_PUBLIC_URL` during authorization and exchange.

## Verification

Run `npm test`. Disposable fixtures cover OAuth consent and negative boundaries, signed Access JWT verification, and bearer proxy isolation. They do not touch live terminals. Production acceptance additionally requires a real user sign-in and connector approval, then same-window listing and harmless input in a disposable visible terminal. Fixture success does not prove actual ChatGPT/Claude UI behavior or production identity policy. Revocation rejects subsequent requests; already forwarded input cannot be undone.
