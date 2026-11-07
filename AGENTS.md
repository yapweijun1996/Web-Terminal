# Web Terminal agent instructions

Before MCP deployment, connection troubleshooting, or a deployment-status answer, read [the MCP connection runbook](docs/mcp-connection-runbook.md) and retrieve relevant KB-MCP context.

- Distinguish the Linux `yapvmmcp` deployment from the Mac deployment. Repository files, historical KB notes, and a running release can differ. Verify the target host, active service paths, and public URL before making claims.
- Report service liveness, public reachability, OAuth compatibility, and actual hosted-client acceptance separately. Metadata HTTP 200 and passing fixtures do not establish a successful ChatGPT connection.
- Check current official client authentication requirements before reusing OAuth callback settings. Preserve exact redirect allowlists, PKCE, resource binding, and Access verification.
- A service-control timeout does not establish that an operation failed. Inspect the live unit and pending job before retrying or rolling back. Obtain explicit authorization for tunnel restarts as required by the user's global instructions.
- Diagnostic logs must exclude query strings, request bodies, headers, tokens, OAuth codes, cookies, and terminal contents.
