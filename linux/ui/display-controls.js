'use strict';

// Shared by the Linux UI and Mac candidate. Settings last for this page only.
window.createTerminalDisplayControls = function createTerminalDisplayControls({ getTerminal, fit }) {
  const details = document.createElement('details'); details.className = 'display-controls';
  const summary = document.createElement('summary'); summary.textContent = 'Display';
  const panel = document.createElement('section'); panel.setAttribute('aria-label', 'Terminal display settings');
  const smaller = document.createElement('button'); smaller.type = 'button'; smaller.textContent = 'Smaller text';
  const larger = document.createElement('button'); larger.type = 'button'; larger.textContent = 'Larger text';
  const contrast = document.createElement('button'); contrast.type = 'button'; contrast.textContent = 'Increase text contrast';
  contrast.setAttribute('aria-pressed', 'false');
  const status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  panel.append(smaller, larger, contrast, status); details.append(summary, panel);
  const originals = new WeakMap();
  let delta = 0, enhanced = false;
  function apply() {
    const term = getTerminal();
    if (!term?.options) { status.textContent = 'Settings apply when the terminal connects'; return; }
    try {
      if (!originals.has(term)) originals.set(term, { size: term.options.fontSize, contrast: term.options.minimumContrastRatio });
      const original = originals.get(term);
      if (!Number.isFinite(original.size)) throw Error('Font size unavailable');
      const size = Math.min(30, Math.max(10, original.size + delta));
      delta = size - original.size;
      term.options.fontSize = size;
      let contrastText = 'standard';
      if (typeof original.contrast === 'number') {
        term.options.minimumContrastRatio = enhanced ? Math.max(4.5, original.contrast) : original.contrast;
        contrastText = enhanced ? 'increased' : 'standard';
      } else if (enhanced) {
        enhanced = false; contrast.setAttribute('aria-pressed', 'false'); contrastText = 'unavailable';
      }
      fit(term);
      status.textContent = `Text ${size}px; contrast ${contrastText}`;
    } catch { status.textContent = 'Display setting unavailable'; }
  }
  smaller.addEventListener('click', () => { delta = Math.max(-20, delta - 2); apply(); });
  larger.addEventListener('click', () => { delta = Math.min(20, delta + 2); apply(); });
  contrast.addEventListener('click', () => {
    enhanced = !enhanced; contrast.setAttribute('aria-pressed', String(enhanced)); apply();
  });
  return { element: details, apply };
};
