'use strict';

// Shared by the Linux UI and the reconstructed Mac client. The adapter returns
// only the currently connected terminal; no key is queued across reconnects.
window.createMobileKeys = function createMobileKeys({ getTerminal, getTargetKey, onLayout = () => {} }) {
  const toggle = document.createElement('button');
  toggle.type = 'button'; toggle.textContent = 'Keys'; toggle.className = 'mobile-keys-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'mobile-keys');
  const panel = document.createElement('section');
  panel.id = 'mobile-keys'; panel.className = 'mobile-keys'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Terminal input keys');
  const notice = document.createElement('span'); notice.className = 'mobile-keys-notice';
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  function send(sequence, restoreFocus) {
    const term = getTerminal();
    if (!term || typeof term.input !== 'function' || term.options?.disableStdin) {
      notice.textContent = 'Terminal unavailable; no key sent'; return false;
    }
    term.input(sequence, true);
    notice.textContent = '';
    if (restoreFocus) term.focus();
    return true;
  }
  for (const [name, sequence, arrow] of [
    ['Esc', '\x1b', false], ['Tab', '\x09', false],
    ['Left', 'D', true], ['Up', 'A', true], ['Down', 'B', true], ['Right', 'C', true],
  ]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = name;
    button.setAttribute('aria-label', arrow ? `${name} arrow` : name);
    button.addEventListener('click', event => {
      if (!arrow) { send(sequence, event.detail > 0); return; }
      const term = getTerminal();
      const mode = term?.modes?.applicationCursorKeysMode;
      if (typeof mode !== 'boolean') { notice.textContent = 'Arrow mode unavailable; no key sent'; return; }
      send(`\x1b${mode ? 'O' : '['}${sequence}`, event.detail > 0);
    });
    panel.append(button);
  }
  const label = document.createElement('label'); label.textContent = 'Ctrl';
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Choose control key');
  let selectedTarget = null;
  select.addEventListener('change', () => { selectedTarget = select.value ? getTargetKey() : null; });
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose'; select.append(empty);
  for (let code = 65; code <= 90; code++) {
    // Ctrl+J and Ctrl+M can submit a shell prompt, so do not offer them here.
    if (code === 74 || code === 77) continue;
    const option = document.createElement('option'); option.value = String(code - 64);
    option.textContent = String.fromCharCode(code); select.append(option);
  }
  label.append(select); panel.append(label);
  const control = document.createElement('button'); control.type = 'button'; control.textContent = 'Send Ctrl';
  function reset() {
    if (select.value) notice.textContent = 'Control key selection cleared; choose again';
    select.value = ''; selectedTarget = null;
  }
  function resetIfTargetChanged() {
    if (select.value && (!selectedTarget || selectedTarget !== getTargetKey())) reset();
  }
  control.addEventListener('click', event => {
    if (!/^(?:[1-9]|1[0-9]|2[0-6])$/.test(select.value) || ['10', '13'].includes(select.value)) {
      notice.textContent = 'Choose a control key'; return;
    }
    if (!selectedTarget || selectedTarget !== getTargetKey()) {
      select.value = ''; selectedTarget = null;
      notice.textContent = 'View changed or unavailable; choose the control key again'; return;
    }
    if (send(String.fromCharCode(Number(select.value)), event.detail > 0)) { select.value = ''; selectedTarget = null; }
  });
  panel.append(control, notice);
  toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) { select.value = ''; selectedTarget = null; notice.textContent = ''; }
    onLayout();
  });
  return { toggle, panel, reset, resetIfTargetChanged };
};
