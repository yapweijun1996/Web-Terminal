# MBA-Terminal collaboration MVP — opt-in agent slice

**LOCAL EXPERIMENTAL — LOCAL DEMO NOT AUTHENTICATED PRODUCTION**

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

## Explicit Codex opt-in

```sh
node collaboration-mvp/server.js --agent codex
```

Only this exact opt-in is accepted. Extra flags, arbitrary commands, alternate paths, environment/developer overrides and `--agent fixture` are rejected. The executable must already exist at `/opt/homebrew/bin/codex` (host version supplied for this slice: 0.166.0). Missing/non-executable Codex fails clearly, with no fallback or auto-install. Automated tests never start real Codex, request a model, or contact an external service.

Pane 1 launches Codex with **no CLI arguments**, retaining its default interactive approval behavior; no `--full-auto` or bypass flags are passed. `/usr/bin/env` directly execs the fixed binary without a shell. Codex runs in a dedicated empty mode `0700` temporary cwd, inside its own new disposable tmux session. Pane 2 stays `/bin/cat -` in a different session on the same new private tmux server/socket. No existing owner/home/production tmux session is attached or controlled. The default command above remains two cat fixtures with no model or external network use. Explicit Codex mode may use the CLI's existing local configuration/authentication and make network/model requests; those are not performed during this task's automated checks. A temporary cwd is not an OS security sandbox or a replacement for Codex approvals.

The same writer/observer URLs, independent view selection, read-only watcher relay, broker lease and text + separate Enter flow apply. CLI and UI label this local experimental. Both plain browser transcripts can receive agent output; they are not full terminal emulators. **Full Codex TUI rendering, interactive approval usability, OAuth and production owner authentication are not verified by the fake-agent test.** Manually opting into Codex is a separate human decision and may incur inference cost.

## Bounded implementation

- Two disposable sessions on a fresh, unpredictable private tmux socket. The default is two direct-exec `/bin/cat -` fixtures; only explicit Codex opt-in replaces Pane 1. No browser shell/command API is exposed.
- A mode `0700` temporary directory contains all Unix sockets. Each fixture window is fixed at 80×24 with `window-size manual` **before** ttyd can attach. Browser resize is never forwarded.
- ttyd runs without `-W`, and attaches tmux with `-r`. There is no browser-facing raw ttyd endpoint. The adapter connects each browser to its own actual ttyd watcher and forwards only output (`0`) messages, never browser protocol frames.
- The custom bounded WebSocket transport supports unfragmented messages and ping/pong; oversized, fragmented or invalid frames close the connection. A missed heartbeat closes the connection within approximately ten seconds. No npm dependencies.
- HMAC-signed, server-provisioned ephemeral identities are verified against an in-memory issued-token registry at upgrade. Browser-supplied principal/UID/permission fields confer no rights. Tokens are local bearer capabilities, not production authentication. HTTP Host and browser Origin are restricted to the exact localhost origin.
- Only A's dev identity can claim input rights. The existing `runtime/gateway/broker.js` owns lease authority, connection binding, expiry and serialization. The adapter allowlists text plus Enter/BSpace/Tab. Text is hex-encoded before tmux command construction. The initial server PID, session/window/pane IDs, pane PID and alive state are pinned and rechecked inside the same tmux `if-shell -F` queue as input, along with manual window sizing. Cat additionally keeps its command-name check; agent liveness never depends on `pane_current_command == cat`. Pane process replacement fails closed even when all four tmux IDs stay the same. Dead panes are retained without restarting a shell; the monitor closes connections on death or identity loss.
- Default mode is watch-only. Pane changes require a fresh lease. Session/ttyd loss closes all connections and denies further upgrades. Invalid input does not automatically retry.
- The page is a bounded plain streaming transcript, not a terminal emulator. It strips ANSI controls, uses `textContent`, and keeps the latest 100,000 characters. tmux full-screen redraws can produce repeated transcript text. It supports text plus Enter through the form; it does not support arbitrary interactive shell commands or client resizing.

## Verification

```sh
node --test tests/collaboration-mvp.test.js tests/input-broker.test.js tests/collaboration-guard.test.js
node --check collaboration-mvp/server.js
node --check collaboration-mvp/client.js
node --check collaboration-mvp/test-agent.js
node --check tests/collaboration-mvp.test.js
git diff --check
```

Tests use two actual Node built-in WebSocket clients, real ttyd/tmux/cat output, the served HTML and the real CLI. They cover independent selection, fixed geometry, observer denial, missing/tampered credentials, forged identity, stolen/stale/disconnected leases, raw protocol and private backend bypass attempts, input allowlists, contention, session loss, and cleanup. The CLI test starts the documented command, uses its two printed capabilities, observes live output, sends SIGTERM, and verifies its listener is gone.

`test-agent.js` is a deterministic executable fixture launched only by explicit programmatic `startDemo({agentMode: 'fixture'})`; it is not a CLI mode or a model. It prints `FIXTURE_AGENT_READY` and generates a labeled JSON-encoded echo only after a complete input line. The new agent Golden E2E uses real tmux/ttyd and two WebSocket browser-protocol clients to check distinct sessions, private cwd, exact Unicode/quoted text plus separate Enter, generated output on both watchers, observer input/takeover denial, independent views, lease revocation, unchanged geometry and same-pane process replacement rejection. Another real fixture test sends SIGTERM to a child demo and checks its recorded processes/directory/listener disappear while a separately created disposable demo survives; it also checks retained dead agent panes fail closed. The three original default E2Es and their negative assertions remain intact. Tests do not use a GUI browser or prove full TUI rendering.

### Verification in this worktree

The original connected-host baseline supplied for HEAD `2b22b2a` was 7/7 tests passing, including 3/3 default real E2Es. That baseline does not validate this change. The current full run reports **5 PASS / 5 FAIL / 0 SKIP**: broker/guard and strict CLI rejection pass; all five real E2Es fail before watcher attachment because tmux reports no private socket at the first `display-message`. An independent disposable Unix socket bind probe returns `EPERM`. Standalone fake-agent ready/JSON-response verification (including Unicode, quotes and shell metacharacters), all four `node --check` commands and `git diff --check` pass. Do not treat these as passed or skipped. Manager must rerun the full command above on MBA host before acceptance, including the new agent E2Es and the original three defaults.

In the Codex sandbox tmux may report success without creating its private socket. Run the exact test command on the permitted host through MBA-Terminal `terminal_exec`; do not attach or select any owner tmux target. Visual browser behavior remains unverified when Playwright/Puppeteer is absent. Manager independent acceptance remains required.

This is a same-UID, local disposable demonstration. It does not resolve the existing trusted-supervisor / cross-UID P0, protect against another process running as the same OS user, or implement production authentication. **Do not merge or deploy it as a production collaboration service.** No production runtime files are changed.
