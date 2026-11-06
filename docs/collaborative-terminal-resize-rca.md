# Watcher attach resize RCA — isolated candidate (2026-11-06)

Status: **SPIKE-LEVEL RESIZE PROOF PASS; overall collaboration release P0 OPEN**.

## Observed failure and cause

A real, disposable ttyd 1.7.7 read-only (`-W` absent) client attached to an 80x24 tmux 3.6a pane. Sending the 101x37 WebSocket handshake caused tmux to report 101x36 (height reflects tmux status line). Read-only ttyd prevents ordinary input but its tmux client attachment can still participate in window sizing. Output-capture whitespace changes were a consequence of geometry change; they did not by themselves prove injected input.

## Minimum isolated fix

Before attaching the watcher, set the targeted shared window to a manual sizing policy; do not change production/global tmux settings without explicit migration review:

```sh
tmux -L "$ISOLATED_TMUX_SERVER" set-window-option -t '=workspace:' window-size manual
```

The original 80x24 detached window remains 80x24 on attach/handshake. Explicit trusted `resize-window -x 90 -y 30` still works. Avoid invoking `resize-window` merely to counter a watcher resize; it is redundant in the verified fixture and introduces an additional mutation.

This changes **window-level state shared by owner and watcher**. For production, a trusted window-size owner/controller must select and document a sizing policy and restore it safely. Do not blindly set all normal interactive windows to manual or allow a viewer to override owner geometry.

## Independent real-process evidence (MBA-Terminal)

| Test | Command | Exit | Evidence |
|---|---|---:|---|
| Baseline | `node tests/spikes/collaborative-enforcement.js` | 1 | 4/6; before 80x24, after attach 101x36; the capture equality check also failed |
| Manual + explicit initial resize | `node tests/spikes/collaborative-enforcement-manual-experiment.js` | 0 | 6/6; before/after 80x24 |
| Manual alone (minimal) | `node tests/spikes/collaborative-enforcement-manual-only-experiment.js` | 0 | 6/6; before/after 80x24 |
| Manual with different watcher size, explicit trusted resize | `node tests/spikes/collaborative-enforcement-manual-variant.js` | 0 | 7/7; watcher handshake 132x45; before/after 80x24; authorized resize 90x30 succeeds |

These scripts use real disposable tmux servers, ttyd Unix sockets and WebSocket frames, and the existing InputBroker adapter, with independently observed process output. The third variant retains the original check display label `101x37` although the sent handshake differs; rely on the test source and measured geometry, not that label.

### What passed

- Writer's broker-authorized text/Enter appear in the read-only watcher stream.
- Watcher credential cannot acquire a write lease.
- Probed watcher text/Enter/paste/resize/control/malformed frames did not change pane content, geometry or process state under manual sizing.
- Separate `-W` writable ttyd negative control successfully writes, showing test sensitivity.
- Trusted explicit tmux resize remains available.
- Disposable test resources were removed; no production sessions or live sockets were accessed.

### Remaining release blockers

This experiment does **not** verify actual authenticated browser principals, original ttyd socket access isolation, MCP/upload writer routing, owner resize UX, production `runtime/attach.sh`, multiple live viewers, reconnection, malicious frame fragmentation, or all resize races. User-visible collaboration still cannot be released. Do not merge or deploy this candidate as a security feature until all relevant P0/P1 controls and bypass checks are independently proven.
