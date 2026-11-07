# MCP connection verification and recovery

## Identify the exact deployment

Do not infer deployment state from this checkout or from another machine's KB memories. Confirm hostname, OS account, repository revision and working-tree changes, active systemd or launchd command, released files, private sockets, tunnel ingress, and public MCP URL. Retrieve KB-MCP context before answering prior-state questions, but treat dated memories as evidence to verify against the current host. Fetch the remote branch before implementing a replacement: this Linux checkout had fallen behind existing upstream consent UI and browser fixes.

The Linux host `yapvmmcp` uses `terminal.yapweijun1996.com` for its browser and `https://terminal-mcp.yapweijun1996.com/mcp` for MCP. The separately maintained Mac deployment recorded in KB uses `terminal.gmb01.xyz` and `terminal-mcp.gmb01.xyz`. Do not copy version, grant-retention, deployment, or authentication claims between them.

Linux uses independent tmux sessions matching `shared` or `web-` plus twelve lowercase hexadecimal digits. Configure `WEB_TERMINAL_MCP_LAYOUT=linux-tabs`; a fixed grouped session does not cover those tabs. MCP listings include `sessionName`; the owner selects the corresponding browser tab manually and refreshes to discover a new one. The default grouped layout retains the Mac behavior.

## Verify each stage independently

1. **Private service:** Verify the actual MCP and OAuth services and private socket permissions. Test initialization and tools/list. Compare MCP session identities with the browser session set without reading terminal contents or sending input to existing panes.
2. **DNS and public routing:** Verify ordinary hostname resolution and DNS answers from independent resolvers. Check public HTTPS metadata and the unauthenticated MCP challenge. A check with `curl --resolve` establishes routing and TLS at the selected public address, but does not establish ordinary DNS resolution for ChatGPT or the user's device.
3. **OAuth compatibility:** Check current official client requirements, metadata issuer, callback mode, exact redirect allowlist, registration method, S256 PKCE and resource binding. Run both [native-form and cross-origin callback regressions](consent-ui-verification.md). Exercise registration and authorization redirect without issuing a production grant during smoke testing.
4. **Hosted-client acceptance:** Obtain evidence of the owner's real sign-in and explicit consent, then verify tool discovery and a harmless operation in a disposable terminal. Do not approve consent for the owner. Until this step succeeds, report "public service verified; hosted-client connection not yet confirmed."

Never label a generic client settings error as a confirmed root cause without correlating the actual request stage. A successful metadata request, fixture test, synthetic DCR request or redirect is a partial check, not full acceptance.

## ChatGPT issuer identification

Current official documentation: [OpenAI plugin authentication](https://developers.openai.com/plugins/build/auth), checked 2026-11-07. Recheck it when investigating a new compatibility problem; this document is not a promise that client behavior remains unchanged.

For an eligible new ChatGPT connection to use `https://chatgpt.com/connector_platform_oauth_redirect`, the authorization server must advertise `authorization_response_iss_parameter_supported: true`, use the exact same issuer in authorization-server and protected-resource metadata, and return that exact issuer as `iss` on both successful and error authorization callbacks. Without this support, new connections use `https://chatgpt.com/connector/oauth/{callback_id}`; an allowlist containing only the old stable URI will not accept that callback mode. Copy the exact URI shown for the connection when using a callback-specific client. Never replace exact allowlists with wildcard callbacks.

This gateway supports Dynamic Client Registration and public-client token authentication (`none`). It does not advertise CIMD support. Preserve exact callback validation, S256 PKCE, single-use codes, the configured `resource`, and approval through the existing Access-protected host. Test both Allow and Deny issuer responses.

## DNS and diagnostic evidence

On 2026-11-07, Google and Cloudflare DNS returned public addresses for the new Linux MCP hostname, while the VM's normal resolver and its upstream returned NXDOMAIN with a negative-cache TTL of 1800 seconds. This is a dated observation, not proof that all client failures are DNS failures. Do not describe an address-overridden curl check as normal hostname resolution, or ask the user repeatedly to retry without investigating the failing stage. Do not modify system DNS or the user's host DNS merely to mask the deployment check.

The OAuth gateway has optional `MCP_AUTH_LOG_REQUESTS=1` diagnostics. They log only the public/approval surface, allowlisted pathname, normalized HTTP method and response status. Unknown paths become `other`; query strings, bodies, headers, identities and secrets are omitted. Use these summaries to distinguish requests that never arrive, discovery, failed registration, authorization and token exchange. A lack of requests does not prove a server implementation fault.

## Service changes and timeout handling

Back up the precise config and record existing pane process identities immediately before activation. Validate ingress matching for MCP, the exact approval path, and terminal/upload routes. Keep Access verification on the approval and terminal routes. The MCP public hostname uses application OAuth and must permit unauthenticated discovery, while MCP calls require a bearer.

Obtain explicit authorization before restarting a tunnel. Restart only the dedicated terminal tunnel when required; preserve ttyd, the UI and tmux. Cloudflared may need longer than a short command deadline to exit gracefully. Submit a nonblocking service restart and inspect `ActiveState`, `SubState`, the current process, pending systemd jobs and subsequent public responses. Do not interpret a timed-out `systemctl` waiter as proof that the service operation failed, issue an overlapping restart, or restore old configuration without first checking current state.

Check the actual gateway release's storage policy before restart. The initial Linux release used in-memory registrations and grants; migrating to the shared persistent gateway requires reconnecting once. The updated Linux gateway uses private state/key paths and `MCP_GRANT_MAX_SECONDS=3600`, preserving its one-hour grant limit. Issued grants and registered clients then survive restart, but unfinished requests/codes do not. Retain a component-specific rollback and verify pane identities and authentication boundaries after activation or recovery. The six-tool Linux MCP runtime is separately pinned; an OAuth-only deployment must not replace it with the newer source runtime.

## Recorded Linux correction, 2026-11-07

The first Linux deployment exposed public metadata successfully but had no RFC 9207 issuer identification and only allowed the stable ChatGPT callback. The owner then reported "Some app settings were rejected." This established a real connection failure, not its sole cause. The missing issuer support was a verified compatibility defect; it was corrected in the gateway and regression-tested for both successful and denied callbacks. Optional redacted request diagnostics were added and their exclusions tested.

After the issuer correction, public checks using an authoritative DNS address returned metadata 200, DCR 201 for the stable ChatGPT callback and `none`, authorization 302 to Access-protected approval, and MCP 401 without a bearer. No production grant was issued. Those partial checks did not establish browser form success.

The owner subsequently reached real consent but received `invalid_request` on native submission within a minute. Focused KB recall and comparison with upstream revealed existing fixes absent from the stale Linux release: `no-referrer` makes Chrome send `Origin: null`, and `form-action 'self'` also blocks a successful POST's cross-origin callback. Reused the upstream styled consent, recovery pages, same-origin referrer policy and exact validated callback CSP. Native HTTPS regression reproduced null-Origin 400 before the fix and verified Allow/Deny 302 and Revoke 303 afterward. A second HTTPS origin verified callback arrival, issuer/state, PKCE exchange and MCP discovery; the old CSP reproduced a blocked callback despite server-side 302. One-hour deployment limits are enforced in both UI and token issuance. Actual owner's hosted-client tool acceptance remains a separate unconfirmed step.
