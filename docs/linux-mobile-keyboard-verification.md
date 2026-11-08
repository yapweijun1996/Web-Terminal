# Linux keyboard workaround: static-only candidate

2026-11-08, Ubuntu ARM64 host `yapvmmcp`. **GO for local static-only candidate review; HOLD for release and for claiming a physical iPhone Safari fix.** This worker did not fetch, push, merge, back up production, deploy, restart a service, access credentials, or open a live terminal/WebSocket. Only isolated fixture terminals received input.

## Scope and provenance

The local remote-tracking baseline is `c25b61e3912f6d3152cbbf3875573dae965ee9e3`, fetched by earlier work at 2026-11-08 07:33:47 +0800. This worker was expressly forbidden to operate on git remote, so **latest remote main is not established**. The release owner must fetch and compare again before integration. Current live disk `server.js`, `index.html`, `app.js` and `style.css` match that local baseline. The user unit runs `/home/ai-agent/.local/share/linux-web-terminal/ui/server.js`; the Mac deployment is outside this task.

The earlier branch commits `e54c612` and `2cf4718` included a reconstructed client fix and a new server-injected script. This rework removes those changes from the final baseline diff. Runtime changes now consist exclusively of `linux/ui/app.js` and `linux/ui/style.css`. `server.js`, `index.html`, the reconstructed client, existing asset routes, tunnels and service configuration have **zero final diff** against the local `origin/main`. The standalone `mobile-viewport.js` is removed.

## Hot-serve evidence

Read-only live source inspection shows existing `/app.js` and `/style.css` handlers call `fs.readFileSync` on each request; `send` sets `Cache-Control: no-store`. Read-only GETs over the existing UI socket returned the same bytes as the live disk for `/`, `/app.js` and `/style.css`. No live `/terminal/` or API route was opened: those routes can create ttyd processes or modify tmux settings even on GET.

The existing server proxies `/terminal/<session>` on the outer origin and injects the existing clipboard/touch hooks. The browser fixture confirms `iframe.contentWindow.location.origin === location.origin` and accesses its real `window.term`. Installed runtime: ttyd 1.7.4, tmux 3.4. The ttyd binary embeds its own xterm client; the reconstructed `client/src` bundle is not the Linux deployment asset.

The browser test starts a **copy of baseline server.js/HTML and baseline assets**, observes their served bytes and no-store headers, then stages and atomically renames only CSS and app.js inside its private fixture. It verifies the running server PID remains alive, newly requested assets match the candidate, and returned HTML remains byte-for-byte identical. A new browser page then exercises those hot-served assets with real ttyd, WebSocket and disposable tmux. This establishes zero-restart feasibility without editing production.

The public Linux browser URL returned unauthenticated HTTP 302 to Access. UI and tunnel remained active with MainPIDs 1101027 and 1101028, started 2026-11-07 21:55:07 +0800. This does not establish signed-in reachability, OAuth compatibility or hosted-client acceptance; those were not tested here. No MCP behavior changed.

## Behavior and ownership

The outer app coalesces visualViewport resize/scroll events into animation frames, fits the existing page shell to visible height/top offset, and refits opened same-origin xterms using ResizeObserver. Iframe load and existing connection messages install the adapter idempotently; tab removal/unload disconnect observers and restore methods. Page restoration can reinstall it. Missing media/viewport APIs retain normal layout or fall back to innerHeight. Zero-height intermediate events and pinch zoom are ignored. Parent controls retain focus.

On coarse pointers, terminal textarea focus uses `preventScroll` and a 16px font. A wrapper around public `term.resize` preserves the normal-buffer history line for height-only changes, using public markers to follow trimming at full scrollback capacity; this also covers ttyd's native FitAddon listener, which bypasses `term.fit`. Width reflow, alternate screens and application output retain xterm/application ownership. Dismissal restores geometry without calling focus, sending keys, reconnecting a WebSocket or replacing an iframe. The design follows the [VisualViewport specification](https://drafts.csswg.org/cssom-view/#the-visualviewport-interface) and [HTML focus options](https://html.spec.whatwg.org/multipage/interaction.html#dom-focus-dev).

Selection is preserved during offset-only panning and pinch. **A real terminal row resize can still clear a selection when tmux resets its mouse protocol.** Both baseline and candidate reproduce this; a stack trace identifies xterm SelectionService.disable from InputHandler.setModePrivate. The adapter does not restore stale selection over application output. This is a known baseline limitation, not a promise to preserve selection across arbitrary redraws. Existing mobile-key delivery limitations in ttyd 1.7.4 (`term.input` absent) are unchanged.

## Verification

| Check | Candidate | Baseline / interpretation |
| --- | --- | --- |
| `node --test linux/test/*.test.js` | 73 passed, 0 failed | Independent baseline: 62 passed, 0 failed; eleven additional adapter checks cover geometry, focus, history ownership, cleanup and unavailable frames. |
| `node --test tests/*.test.js` | 40 passed, 5 failed, 1 skipped | Independent baseline: same 40/5/1 and same five failures associated with required tmux 3.6a versus installed 3.4. No new root failure. |
| Real Linux outer UI + embedded ttyd Chromium | Passed | Synthetic keyboard; private baseline server with atomic static replacement. |
| Real Linux outer UI + embedded ttyd WebKit | Passed | Synthetic keyboard; installed WebKit executable selected explicitly. |
| Baseline keyboard negative control, Chromium + WebKit | Both passed | Baseline retains 844px outer height and unchanged rows when synthetic keyboard opens; native row resize reproduces tmux selection clearing. |
| Final diff and syntax | Checked | No server.js/HTML/client/config changes against local tracking baseline. |

Browser checks include keyboard open/dismiss, last-row cursor visibility, offset-only pan without PTY resize, zero height, pinch, landscape, expanded Keys, parent input focus, same-width normal-buffer history at full scrollback capacity including dismissal, selection during pan/zoom, alternate screen, tmux copy mode, unsubmitted draft, pane PID, no layout-generated input/reconnect, desktop and no-viewport fallback, a second tab and reuse of the original iframe. Chromium additionally dispatches real browser touch gestures through the outer page into ttyd, verifies both scroll directions and preserves the draft. Only synthetic terminal output is captured.

Playwright module used: `/tmp/web-terminal-browser-Zj7Obr/node_modules/playwright` (1.65.0). Chromium uses `/usr/bin/google-chrome`; the module's default WebKit was missing, so tests explicitly use `/home/ai-agent/.cache/ms-playwright/webkit-2370/pw_run.sh`. No package, browser or host component was installed. Browser versions and geometry are in each run's measurements.json.

Reproduce from this checkout:

```sh
node --test linux/test/*.test.js
node --test tests/*.test.js
PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/linux-mobile-keyboard.e2e.cjs
PLAYWRIGHT_MODULE=/path/to/playwright BROWSER=webkit WEBKIT_BIN=/path/to/pw_run.sh node tests/browser/linux-mobile-keyboard.e2e.cjs
PLAYWRIGHT_MODULE=/path/to/playwright KEYBOARD_BASELINE=1 node tests/browser/linux-mobile-keyboard.e2e.cjs
PLAYWRIGHT_MODULE=/path/to/playwright BROWSER=webkit WEBKIT_BIN=/path/to/pw_run.sh KEYBOARD_BASELINE=1 node tests/browser/linux-mobile-keyboard.e2e.cjs
```

Current evidence is under ignored `artifacts/static-keyboard/` (suite logs, read-only live hashes and final checks); browser stdout identifies per-run `artifacts/lk-*` screenshots/measurements. Earlier `artifacts/linux-keyboard/` evidence belongs to the superseded server-injection candidate, except its unchanged origin baseline snapshot used for comparison. It must not be presented as this candidate's passing evidence.

## Remaining release gates and owner handoff (not executed)

1. An authorized integration worker must fetch current main, reconcile any newer changes and repeat affected checks. Review/accept or resolve the existing root-suite environment failures and baseline mouse-mode selection limitation. This worker cannot certify that all release gates pass.
2. Review only the final diff: two existing runtime assets plus documentation and tests. Reject any payload that changes server.js, HTML, service configuration, adds asset routes or requires a restart. Back up the precise live app.js/style.css with an owner-only manifest before any separately authorized production replacement.
3. A later authorized deployer can stage both assets on the live filesystem, verify hashes/permissions, rename style.css first (its new rules are inert without the new app class), then app.js. Each rename is atomic; the pair is not one filesystem transaction. No restart is needed. Rollback restores app.js first, then CSS, using atomic renames. Existing loaded pages retain old code until refresh; do not refresh the owner's active sessions without coordination.
4. Verify newly served hashes and unchanged HTML/server/service identities, then use a disposable signed-in physical iPhone Safari session for keyboard open/dismiss, cursor, history, draft, selection, rotation, zoom, clipboard and tab switching. No physical device, native keyboard or authenticated production iframe was exercised here.

**Release HOLD remains.** The static-only architecture is feasible and locally tested; remote freshness, production activation, physical iPhone behavior and the owner's acceptance of documented baseline limitations remain outside this worker's verified result.
