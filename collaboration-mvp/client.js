'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  // Keep capability URLs out of subsequent history entries and HTTP referrers.
  history.replaceState(null, '', location.pathname);
  let selectedPane = null, lease = null, role = 'observer', leaseMs = 15000;
  let pending = [], outputBuffer = '', decoderTail = '';
  const state = text => { $('state').textContent = text; };
  const controls = () => {
    $('claim').disabled = role !== 'writer' || !selectedPane || !!lease;
    $('release').disabled = !lease;
    $('text').disabled = $('send').disabled = !lease;
  };
  if (!token) { state('Missing dev identity. Open a URL printed by the demo command.'); return; }
  const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  const send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  function select(pane) {
    lease = null; selectedPane = pane; outputBuffer = ''; decoderTail = ''; $('output').textContent = ''; controls();
    for (const button of document.querySelectorAll('[data-pane]')) button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
    state(`Selecting Pane ${pane}; watch-only`); send({ type: 'select', pane });
  }
  // Strip terminal control sequences; this bounded transcript is not an xterm emulator.
  function transcript(chunk) {
    let text = decoderTail + chunk; decoderTail = '';
    const tail = text.lastIndexOf('\x1b');
    if (tail >= 0 && /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07]*)$/.test(text.slice(tail))) { decoderTail = text.slice(tail).slice(-2048); text = text.slice(0, tail); }
    return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-Z\\-_]/g, '').replace(/\r/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') { role = m.role; leaseMs = m.leaseMs; select('1'); }
    if (m.type === 'selected' && m.pane === selectedPane) { state(`${role}; local Pane ${selectedPane}; watch-only`); controls(); }
    if (m.type === 'output' && m.pane === selectedPane) {
      outputBuffer = (outputBuffer + transcript(m.data)).slice(-100000);
      $('output').textContent = outputBuffer; $('output').scrollTop = $('output').scrollHeight;
    }
    if (m.type === 'lease') { lease = m.lease; state(`${role}; local Pane ${selectedPane}; writer lease active`); controls(); }
    if (m.type === 'released' || m.type === 'error') {
      lease = null; pending = []; controls(); state(`${role}; local Pane ${selectedPane}; watch-only`);
      $('notice').textContent = m.type === 'error' ? m.message : 'Lease released.';
    }
    if (m.type === 'ack' && pending.length) send(pending.shift());
  };
  ws.onclose = ws.onerror = () => { lease = null; selectedPane = null; controls(); state('Disconnected; input disabled. Restart using a printed dev URL.'); };
  for (const button of document.querySelectorAll('[data-pane]')) button.onclick = () => select(button.dataset.pane);
  $('claim').onclick = () => send({ type: 'claim' });
  $('release').onclick = () => { send({ type: 'release', lease }); lease = null; controls(); };
  $('input').onsubmit = event => {
    event.preventDefault(); if (!lease || !$('text').value || pending.length) return;
    pending.push({ type: 'input', lease, operation: { type: 'key', key: 'Enter' } });
    send({ type: 'input', lease, operation: { type: 'text', text: $('text').value } }); $('text').value = '';
  };
  setInterval(() => { if (lease) send({ type: 'renew', lease }); }, Math.max(100, Math.floor(leaseMs / 3)));
})();
