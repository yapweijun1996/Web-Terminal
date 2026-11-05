'use strict';

// Shared by the embedded Linux ttyd client and the standalone Mac client.
// xterm's native touch handler skips mouse-reporting terminals (including tmux).
function installTerminalTouchScroll(document, getTerminal, now = Date.now) {
  const style = document.createElement('style');
  // Reserve one-finger panning before the browser commits to page scrolling;
  // pinch zoom stays available. This also applies to terminals created later.
  style.textContent = '.xterm { touch-action: pinch-zoom; }';
  document.head.append(style);
  let gesture = null;
  const reset = () => { gesture = null; };
  const options = { capture: true, passive: false };
  const listeners = [];
  const listen = (type, handler) => {
    document.addEventListener(type, handler, options);
    listeners.push([type, handler]);
  };
  const usable = terminal => terminal?.element && !terminal.options?.disableStdin;
  listen('touchstart', event => {
    reset();
    const terminal = getTerminal();
    if (event.touches.length !== 1 || !usable(terminal) || terminal.hasSelection?.() ||
        !terminal.element.contains(event.target)) return;
    const touch = event.touches[0];
    gesture = { terminal, id: touch.identifier, x: touch.clientX, y: touch.clientY,
      lastY: touch.clientY, pending: 0, started: now(), scrolling: false };
    // Keep the native viewport handler from scrolling a second time. Do not
    // cancel the default: taps, long press and multi-touch zoom remain native.
    event.stopPropagation();
  });
  listen('touchmove', event => {
    if (!gesture) return;
    const g = gesture;
    const terminal = getTerminal();
    const touch = [...event.touches].find(item => item.identifier === g.id);
    if (event.touches.length !== 1 || !touch || terminal !== g.terminal || !usable(terminal) ||
        terminal.hasSelection?.()) { reset(); return; }
    const dx = touch.clientX - g.x, dy = touch.clientY - g.y;
    if (!g.scrolling) {
      if (now() - g.started > 450 || (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy))) { reset(); return; }
      if (Math.abs(dy) < 8) { event.stopPropagation(); return; }
      g.scrolling = true;
    }
    if (!event.cancelable) { reset(); return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    const screen = terminal.element.querySelector('.xterm-screen');
    const rect = screen?.getBoundingClientRect();
    if (!rect?.height || !terminal.rows) { reset(); return; }
    g.pending += g.lastY - touch.clientY;
    g.lastY = touch.clientY;
    const rowHeight = rect.height / terminal.rows;
    const lines = Math.max(-20, Math.min(20, Math.trunc(g.pending / rowHeight)));
    g.pending -= lines * rowHeight;
    // Mouse-aware apps and tmux receive ordinary wheel reports, one per row.
    // Never synthesize arrow keys: they can edit an unsubmitted shell/TUI draft.
    if (terminal.modes?.mouseTrackingMode && terminal.modes.mouseTrackingMode !== 'none') {
      const clientX = Math.max(rect.left + 1, Math.min(rect.right - 1, g.x));
      const clientY = Math.max(rect.top + 1, Math.min(rect.bottom - 1, touch.clientY));
      for (let i = 0; i < Math.abs(lines); i++) {
        terminal.element.dispatchEvent(new document.defaultView.WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaMode: 1, deltaY: Math.sign(lines), clientX, clientY,
        }));
      }
    } else if (lines) {
      terminal.scrollLines(lines);
    }
  });
  listen('touchend', event => {
    if (gesture?.scrolling && event.cancelable) event.preventDefault();
    reset();
  });
  listen('touchcancel', reset);
  listen('visibilitychange', reset);
  return { dispose() { reset(); style.remove(); for (const [type, handler] of listeners) document.removeEventListener(type, handler, options); } };
}

if (typeof module === 'object' && module.exports) module.exports = { installTerminalTouchScroll };
else installTerminalTouchScroll(document, () => window.term);
