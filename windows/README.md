# Native Windows terminal

This adapter runs Windows PowerShell through native ConPTY. It is separate from
the repository's ttyd/tmux implementations. A browser can create up to 20 shells,
hide or restore a view, reconnect to the same shell, or explicitly end a shell.
Hiding a view and disconnecting do not end its work. Each shell uses an isolated
PTY worker process. Screen history stays in memory, limited to 5,000 lines.

## Access boundary

Every HTTP request and WebSocket upgrade requires a cryptographically verified
Cloudflare Access JWT with the configured RS256 signature, team issuer,
application audience, expiry and owner email. There is no development bypass.
Mutation requests also require the exact HTTPS Origin and a process-specific
request token. WebSockets require the same Origin and token and close when their
JWT expires. Invalid authentication returns 403 before any shell is created.

Bind the application to loopback only, and put the entire hostname behind an
Access self-hosted application with an explicit email Allow policy, no Bypass
policy, and a suitable identity provider. A dedicated named tunnel must validate
the same Access audience before forwarding. Do not reuse another connector's
tunnel with different ingress rules. Review existing wildcard applications and
policies before publishing. Access revocation of already-issued JWTs remains a
separate acceptance check; token expiry alone does not prove immediate revocation.

Shells have the current Windows user's permissions. Other processes running as
that same user are trusted. This is not a multi-user isolation boundary. No
terminal output, credentials, or command input is written to server logs. This
adapter does not implement image uploads or the optional MCP service.

## Local setup

Use native Windows with Node.js 22 or later:

```powershell
Set-Location windows
npm.cmd ci --no-fund --no-audit
npm.cmd test
Copy-Item deployment.example.json deployment.local.json
Copy-Item cloudflared.example.yml cloudflared.local.yml
```

Populate the ignored local files only after verifying the actual Access
application, allowed identity, team, audience and dedicated tunnel credentials.
Examples intentionally fail validation until completed. Do not commit local
configuration, account details, tokens or credentials. Keep deployment files
restricted to the owner and required system administrators using Windows ACLs.

With configuration and protection verified, run from this directory:

```powershell
.\run.ps1 -CloudflaredPath 'C:\approved\path\cloudflared.exe'
```

The launcher confirms loopback listener ownership before starting its connector.
It restarts only a disconnected connector. To configure at-logon startup, use a
dedicated owner task with an interactive, least-privilege logon and no execution
time limit after completing live acceptance. Do not register a task with example
values. Keep the existing ERP and Inspector tasks unchanged.

## Lifecycle and verification

PowerShell jobs and unsubmitted input survive browser disconnects while the
terminal service and worker remain running. A service restart, Windows logout or
reboot ends shells. Sleep prevents remote access. Startup is not recovery of old
shells. Multiple attached views share a shell's size and input. Input is never
queued during reconnect. Reconnect restores the headless terminal's screen.

The pinned node-pty inbox backend has a natural-exit resource leak tracked in
[upstream issue 965](https://github.com/microsoft/node-pty/issues/965). Each PTY is
therefore hosted in a separate process using the bundled ConPTY DLL. Worker exit
reclaims native handles and parser state stays with the application. Do not call
kill twice on the same pseudoconsole.

`npm.cmd test` uses disposable real PowerShell sessions, ephemeral loopback HTTP
and WebSocket listeners and temporary signing keys. It checks signature, issuer,
audience, expiry and email rejection; unauthorized HTTP/WS; Origin and mutation
token rejection; shell creation; resize; job continuity; unsent draft retention;
and shell exit. It does not exercise Cloudflare, the owner's browser, physical
devices, screen readers, long-duration operation or Windows logon/sleep/reboot.

Before release, verify the real Access policy and public unauthenticated HTTP and
WS denial, owner sign-in, real browser input/resize/hide/restore/reload, unrelated
shell preservation, expiry and revocation. Record actual results and limitations.

For rollback, keep Access enabled, restore only this hostname's previous DNS
record, and stop only this adapter's task and connector. Ending its terminal
service ends its shells; inspect active work before doing so. Never stop other
cloudflared processes or delete retained user data.

## Deployment verification

On 2026-11-06, native PowerShell and Access fixture verification passed on the
owner's PC. The owner manually created the Access application, confirmed its
email policy and supplied its audience. The existing account's Access team was
reused after checking its public key endpoint. A new dedicated tunnel was
created and its Access-validating ingress passed validation and route selection.
The loopback terminal and its dedicated connector are running; the connector
reported four ready connections. Requests to the terminal root and session API
without an Access JWT returned 403. Existing ERP and Inspector connectors also
reported four ready connections each. After the owner added the DNS route,
unauthenticated public requests to the root, script, session API and a real
WebSocket upgrade request all returned 302 to the configured Access team domain.
The owner-scoped `Web Terminal TNO` at-logon task is registered with interactive
logon, limited privileges, no execution time limit and duplicate-run rejection.
It has not been started separately because the current launcher is already
running. The owner subsequently confirmed the public terminal works and supplied
a Chrome screenshot showing the connected terminal running a CLI. This supports
basic authenticated page, WebSocket and input/output acceptance. Full browser
hide/restore/reconnect, live revocation and actual at-logon behavior remain
unverified; no logout or reboot was performed to test them.

DNS and Access organization reads returned HTTP 403 using the existing tunnel
certificate. Both supported browser control and Windows Computer Use reported
unavailable host/pipe connections. Local account-specific configuration,
connector credentials and process state remain outside version control.

The final native test run passed both test groups, including actual shell
termination and preservation of the other shell. JavaScript and PowerShell
syntax checks passed; npm reported zero dependency vulnerabilities. A broader
legacy/UI run passed 26 checks, failed 12 and skipped 3 on Windows: failures
included Unix socket/symlink prerequisites, Unix-only upload fixture startup,
shell-script execution and the absent client TypeScript installation. Those
legacy sources were not modified. This is not a passing full-repository result.
The two existing local tunnel readiness endpoints still reported HTTP 200 and
four ready connections each after verification.

References:

- [Cloudflare origin Access validation](https://developers.cloudflare.com/tunnel/reference/origin-parameters/#access)
- [Microsoft node-pty](https://github.com/microsoft/node-pty)
