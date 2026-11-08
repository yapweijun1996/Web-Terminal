# Linux terminal collaboration

The default UI transport is unchanged. Configure collaboration only as a coordinated
release with the matching MCP and OAuth gateway adapters. Keep the release directory
layout: `linux/ui`, `linux/node_modules`, `mcp/terminal.js`, `mcp/terminal-errors.js`,
and `runtime/gateway/{broker.js,collaboration-contract.cjs}`.

Install the pinned WebSocket transport locally with `npm ci --ignore-scripts` in
`linux`; no system or ttyd/tmux upgrade is required. The package pins `ws` 8.22.1,
including its IPC URL handling fix. [Upstream releases](https://github.com/websockets/ws/releases/tag/8.22.1).

The UI service needs private configuration:

```text
TERMINAL_COLLABORATION_SOCKET=/absolute/private/runtime/collaboration.sock
TERMINAL_OWNER_VERIFY_SOCKET=/absolute/private/gateway/approval.sock
TERMINAL_OWNER_VERIFY_URL=https://terminal.example.com/existing-approval-path
TERMINAL_GRANT_VERIFY_SOCKET=/absolute/private/gateway/grant-verifier.sock
```

The coordinator socket parent must be owned and mode0700; the socket is mode0600.
These sockets are a same-account trust boundary, not isolation against processes
already holding terminal OS authority. The owner verifier uses signed Access JWTs;
the grant verifier reads live delegated grants without exposing bearer tokens.

In coordinated mode, MCP input needs a short-lived, single-use, request-bound
admission and current `inputGeneration`. Human browser input and image insertion
pause AI across **all managed terminals**, not only the WebSocket URL's original session. Native tmux prefixes
and mouse navigation can switch the actual client to another session. Every
known generation/lease is invalidated immediately, newly discovered sessions
default to paused, and all in-flight MCP writes drain before native bytes are
forwarded. Resume sharing applies only to the explicitly chosen terminal. Owner
Pause/Take control acknowledges only after pending MCP writes drain; unknown delivery stays blocked. Resume sharing is deliberate and
rotates the generation. Expired writer leases also rotate generation, so a delayed
Enter cannot silently reacquire authority and submit another draft. Input is pinned
to the pane process captured server-side, not a foreground command PID.

The mature WebSocket proxy preserves complete binary/fragmented messages, native
ttyd handshake, resize and output flow control. Owner input bytes stay unchanged.
Images, mobile keys and paste use the same session pause boundary. Opening/reloading
the browser after the UI upgrade is required to load the new owner controls.

The tested ttyd1.7.4 xterm emits automatic terminal protocol replies through the
same onData path as user input. A guarded owner-frontend adapter preserves xterm's
`wasUserInput` provenance rather than guessing from escape bytes. Explicit protocol
replies use a private owner-WebSocket marker, converted back to native ttyd input
before forwarding. Omitted provenance is normalized only when the shipped xterm's
explicit default-false method signature is recognized. Unknown implementations,
binary/untagged input and missing API support retain fail-safe owner takeover.
This marker is available only within an independently authenticated owner channel;
it is neither a public MCP role flag nor an authorization grant.

The legacy native xterm lacks the newer public `input()` method; its mobile input
adapter delegates through the same core user-input service. Real browser tests
exercise keyboard, paste, mobile Tab, CPR/DA responses and owner controls at desktop
and390px. Terminal application completion cannot be inferred from a WebSocket send
callback, and direct OS/tmux writers remain outside managed arbitration.

Run `node --test linux/test/*.test.js` for regressions. Run the real signed-owner
OAuth/browser fixture with:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node linux/test/collaboration-browser.e2e.cjs
```

Fixtures use private disposable tmux/ttyd sessions and signed test-only owner JWTs,
normal DCR/consent/PKCE, the actual gateway, MCP and coordinator. They never issue a
production grant or operate on existing sessions. Browser evidence defaults to the
ignored `artifacts/collaboration-browser/` directory.
