'use strict';

// ttyd forwards tmux's OSC 52 copy sequences but its embedded client does not
// deliver them to the browser clipboard. Forward copy requests to the parent;
// the parent requires an active view and a user gesture before writing.
(() => {
  const WebSocketWithStatus = window.WebSocket;
  const prefix = '\x1b]52;';
  const maxSequence = 1400000;
  window.WebSocket = class extends WebSocketWithStatus {
    constructor(...args) {
      super(...args);
      let pending = '';
      const decoder = new TextDecoder();
      this.addEventListener('message', event => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes[0] !== 48) return; // ttyd protocol: terminal output
        pending += decoder.decode(bytes.subarray(1), { stream: true });
        while (pending) {
          const start = pending.indexOf(prefix);
          if (start < 0) { pending = pending.slice(-(prefix.length - 1)); break; }
          if (start > 0) pending = pending.slice(start);
          const bell = pending.indexOf('\x07', prefix.length);
          const st = pending.indexOf('\x1b\\', prefix.length);
          const end = bell < 0 ? st : st < 0 ? bell : Math.min(bell, st);
          if (end < 0) { if (pending.length > maxSequence) pending = ''; break; }
          const sequence = pending.slice(prefix.length, end);
          pending = pending.slice(end + (end === st ? 2 : 1));
          const match = /^[cps0-7]*;([A-Za-z0-9+/]+={0,2})$/.exec(sequence);
          if (!match || match[1].length > maxSequence) continue;
          try {
            const raw = atob(match[1]);
            const data = Uint8Array.from(raw, character => character.charCodeAt(0));
            const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
            if (text) window.parent.postMessage({ type: 'terminal-clipboard', text }, window.location.origin);
          } catch { /* Ignore malformed or non-text clipboard data. */ }
        }
      });
    }
  };
})();
