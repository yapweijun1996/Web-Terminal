# MBA-Terminal collaboration MVP — slice 1

**LOCAL DEMO NOT AUTHENTICATED PRODUCTION**

Run from this worktree, with Node 23+, tmux **3.6a** and ttyd **1.7.7** already installed:

```sh
node collaboration-mvp/server.js
```

No npm install, internet access, production runtime, tunnel, or existing tmux session is required. The command prints two different localhost capability URLs. Open Client A and Client B in two browser tabs manually. Only `127.0.0.1` is bound, on an automatically allocated port.

1. Both views initially watch Pane 1. Each page has its own Pane 1 / Pane 2 buttons and local selected state.
2. In Client A, click **Claim writer lease**, enter `hello`, and click **Send text + Enter**. Both views receive the actual `/bin/cat` output live through separate read-only ttyd WebSockets.
3. Client B is an observer: writer controls remain disabled. Even forged input, identity or lease messages are denied by the server.
4. Select Pane 2 in B; A stays on Pane 1. Return B to Pane 1 to see A's output. Selection never invokes `tmux select-window` or `select-pane`.
5. A may release its lease. Disconnecting or changing panes revokes its lease. Unrenewed leases expire after 15 seconds; the page renews an active lease while connected.
6. Stop with Ctrl-C. SIGINT/SIGTERM terminate only this run's two ttyd processes, disposable tmux server/fixtures, and private temporary directory. Abrupt SIGKILL or host failure cannot run cleanup; never use this fixture server for valuable work.

Reloading a page requires reopening its printed URL: the page removes the token fragment from the address bar after reading it and keeps the token only in memory. Dev tokens expire after eight hours and are invalid after a server restart. Do not share the printed writer URL.

## Bounded implementation

- Two disposable sessions, each containing a direct-exec `/bin/cat -` fixture, on a fresh, unpredictable private tmux socket. No shell/command API is exposed.
- A mode `0700` temporary directory contains all Unix sockets. Each fixture window is fixed at 80×24 with `window-size manual` **before** ttyd can attach. Browser resize is never forwarded.
- ttyd runs without `-W`, and attaches tmux with `-r`. There is no browser-facing raw ttyd endpoint. The adapter connects each browser to its own actual ttyd watcher and forwards only output (`0`) messages, never browser protocol frames.
- The custom bounded WebSocket transport supports unfragmented messages and ping/pong; oversized, fragmented or invalid frames close the connection. A missed heartbeat closes the connection within approximately ten seconds. No npm dependencies.
- HMAC-signed, server-provisioned ephemeral identities are verified against an in-memory issued-token registry at upgrade. Browser-supplied principal/UID/permission fields confer no rights. Tokens are local bearer capabilities, not production authentication. HTTP Host and browser Origin are restricted to the exact localhost origin.
- Only A's dev identity can claim input rights. The existing `runtime/gateway/broker.js` owns lease authority, connection binding, expiry and serialization. The adapter allowlists text plus Enter/BSpace/Tab. Text is hex-encoded before tmux command construction. Target identity and `cat` liveness are rechecked inside tmux's command queue.
- Default mode is watch-only. Pane changes require a fresh lease. Session/ttyd loss closes all connections and denies further upgrades. Invalid input does not automatically retry.
- The page is a bounded plain streaming transcript, not a terminal emulator. It strips ANSI controls, uses `textContent`, and keeps the latest 100,000 characters. tmux full-screen redraws can produce repeated transcript text. It supports text plus Enter through the form; it does not support arbitrary interactive shell commands or client resizing.

## Verification

```sh
node --test tests/collaboration-mvp.test.js tests/input-broker.test.js
```

Tests use two actual Node built-in WebSocket clients, real ttyd/tmux/cat output, the served HTML and the real CLI. They cover independent selection, fixed geometry, observer denial, missing/tampered credentials, forged identity, stolen/stale/disconnected leases, raw protocol and private backend bypass attempts, input allowlists, contention, session loss, and cleanup. The CLI test starts the documented command, uses its two printed capabilities, observes live output, sends SIGTERM, and verifies its listener is gone.

In the Codex sandbox tmux may report success without creating its private socket. Run the exact test command on the permitted host through MBA-Terminal `terminal_exec`; do not attach or select any owner tmux target. Visual browser behavior remains unverified when Playwright/Puppeteer is absent. Manager independent acceptance remains required.

This is a same-UID, local disposable demonstration. It does not resolve the existing trusted-supervisor / cross-UID P0, protect against another process running as the same OS user, or implement production authentication. **Do not merge or deploy it as a production collaboration service.** No production runtime files are changed.
