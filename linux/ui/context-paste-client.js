'use strict';
window.createContextPaste = function ({ getSession, getTarget, getToken }) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Paste context'; button.id = 'paste-context';
  const dialog = document.createElement('dialog'); dialog.id = 'context-editor'; dialog.setAttribute('aria-labelledby', 'context-title');
  dialog.innerHTML = `<h2 id="context-title">Paste context</h2><p id="context-target"></p>
    <label for="context-text">Context (kept in this page until you create a file)</label><textarea id="context-text" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
    <p id="context-count"></p><p id="context-message" role="status" aria-live="polite"></p>
    <p class="context-help">Multiline text becomes a private text file for your AI to read. Insert only a file path or a single line, then press Enter separately in the terminal. Inserting pauses managed AI input in all terminals; use Resume sharing explicitly afterward.</p>
    <label id="context-path-label" hidden>Context file path<input id="context-path" readonly></label>
    <div class="context-actions"><button type="button" data-action="recapture">Refresh target</button><button type="button" data-action="clipboard">Read clipboard</button><button type="button" data-action="copy">Copy text</button><button type="button" data-action="file">Create context file</button><button type="button" data-action="copy-path" hidden>Copy path</button><button type="button" data-action="delete" hidden>Delete file</button><button type="button" data-action="confirm">Confirm target</button><button type="button" data-action="insert" disabled>Insert single line</button><button type="button" data-action="cancel">Cancel</button></div>`;
  document.body.append(dialog);
  const text = dialog.querySelector('textarea'), status = dialog.querySelector('#context-message'), targetLabel = dialog.querySelector('#context-target'), count = dialog.querySelector('#context-count'), pathInput = dialog.querySelector('#context-path');
  const action = name => dialog.querySelector(`[data-action="${name}"]`);
  let clipboardPending = false, editorEpoch = 0;
  let initialReceipt = null, captured = null, confirmed = null, saved = null, busy = false, composing = false, terminalUncertain = false;
  const bytes = value => new TextEncoder().encode(value).length;
  const canInsert = value => value.length > 0 && bytes(value) <= 8192 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
  const fileValid = () => text.value.length > 0 && bytes(text.value) <= 65536 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text.value);
  const insertion = () => saved?.path || text.value;
  const savedCurrent = () => !saved || saved.draft === text.value;
  function sameView() {
    const current = getTarget();
    return captured && getSession() === captured.session && current && ['session', 'sessionId', 'serverPid'].every(key => current[key] === captured[key]) && current.pane === captured.paneId;
  }
  function render() {
    text.readOnly = busy; action('cancel').disabled = busy; action('recapture').disabled = busy;
    count.textContent = `${[...text.value].length} characters · ${text.value.split('\n').length} lines · ${bytes(text.value)} / 65536 UTF-8 bytes${bytes(text.value) > 65536 ? ' — too large; shorten the draft before creating a file' : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text.value) ? ' — unsupported control characters; remove them before transfer' : ''}`;
    pathInput.value = saved?.path || ''; dialog.querySelector('#context-path-label').hidden = !saved;
    action('copy-path').hidden = action('delete').hidden = !saved;
    action('file').disabled = busy || Boolean(saved) || !fileValid() || !captured || !sameView();
    action('confirm').disabled = busy || composing || !captured || !sameView() || !canInsert(insertion()) || terminalUncertain || !savedCurrent();
    action('insert').disabled = busy || composing || !confirmed || !sameView() || terminalUncertain || !savedCurrent();
    action('insert').textContent = saved ? 'Insert file path' : 'Insert single line';
    for (const name of ['clipboard', 'copy', 'copy-path', 'delete']) action(name).disabled = busy;
    action('clipboard').disabled = busy || clipboardPending;
  }
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  async function api(name, body) {
    const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), 10000);
    try {
    const response = await fetch('/api/context/' + name, { method: 'POST', signal: abort.signal, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': getToken() }, body: JSON.stringify(body) });
    if (!response.ok) throw Error(response.status === 404 ? 'Context transfer needs the owner coordinator.' : response.status === 401 || response.status === 403 ? 'Owner authorization is unavailable. Your draft is retained.' : 'Target or confirmation changed. Your draft is retained; use Refresh target, then confirm again.');
    return await response.json();
    } finally { clearTimeout(deadline); }
  }
  async function prepare(value, purpose) {
    if (!sameView()) throw Error('Terminal view changed or disconnected. Your draft is retained. Reopen to capture a target.');
    return api('prepare', { session: captured.session, previous: initialReceipt, expected: captured, digest: await hash(value), purpose, bytes: bytes(value) });
  }
  async function run(operation) { if (busy) return; busy = true; render(); try { await operation(); } catch (error) { status.textContent = error.message || 'Unavailable. Your draft is retained.'; } finally { busy = false; render(); } }
  async function open() {
    if (busy) return;
    editorEpoch++; composing = false;
    captured = confirmed = null; terminalUncertain = false;
    targetLabel.textContent = 'Verifying terminal target…'; status.textContent = 'Paste with your keyboard or long-press in the editor, or choose Read clipboard.';
    if (!dialog.open) dialog.showModal(); resize(); text.focus(); render();
    await run(async () => {
      const session = getSession(), observed = getTarget();
      if (!session || !observed || observed.session !== session) throw Error('Connect the intended terminal first. You can still edit or copy your draft.');
      const result = await api('prepare', { session, expected: { session, sessionId: observed.sessionId, serverPid: observed.serverPid, paneId: observed.pane } });
      if (getSession() !== session) throw Error('Terminal view changed. Reopen to capture the intended target.');
      captured = result.target; initialReceipt = result.receipt;
      targetLabel.textContent = `Target: ${captured.session} · window ${captured.windowId} · pane ${captured.paneId}`;
    });
  }
  button.addEventListener('click', open);
  text.addEventListener('input', () => { confirmed = null; if (saved) status.textContent = 'Saved file still contains the earlier text. Delete it before creating an updated file.'; render(); });
  text.addEventListener('compositionstart', () => { composing = true; render(); });
  text.addEventListener('compositionend', () => { composing = false; render(); });
  text.addEventListener('keydown', event => { if (event.key === 'Enter') event.stopPropagation(); });
  action('clipboard').addEventListener('click', async () => {
    if (clipboardPending) return;
    const epoch = editorEpoch, draft = text.value;
    if (!navigator.clipboard?.readText) { status.textContent = 'Clipboard reading unavailable. Long-press in the editor or use your keyboard clipboard.'; text.focus(); return; }
    clipboardPending = true; render();
    let deadline;
    try {
      const value = await Promise.race([navigator.clipboard.readText(), new Promise((resolve, reject) => { deadline = setTimeout(() => reject(Error('Clipboard pending')), 10000); })]);
      if (!dialog.open || editorEpoch !== epoch || text.value !== draft) return;
      text.setRangeText(value, text.selectionStart, text.selectionEnd, 'end'); confirmed = null; status.textContent = 'Clipboard text added to the editor.';
    } catch { if (dialog.open && editorEpoch === epoch) status.textContent = 'Clipboard permission denied or unavailable. Long-press in the editor or use your keyboard clipboard. Your draft is retained.'; }
    finally { clearTimeout(deadline); clipboardPending = false; render(); if (dialog.open && editorEpoch === epoch) text.focus(); }
  });
  async function copy(value, label) {
    try { if (!navigator.clipboard?.writeText) throw Error(); await Promise.race([navigator.clipboard.writeText(value), new Promise((resolve, reject) => setTimeout(() => reject(Error('Copy unavailable')), 10000))]); status.textContent = label + ' copied.'; }
    catch { const field = label === 'Path' ? pathInput : text; field.focus(); field.select(); status.textContent = 'Use your keyboard or selection menu to copy the selected ' + label.toLowerCase() + '.'; }
  }
  action('copy').addEventListener('click', () => run(() => copy(text.value, 'Text')));
  action('copy-path').addEventListener('click', () => run(() => copy(saved.path, 'Path')));
  action('file').addEventListener('click', () => run(async () => {
    if (saved) throw Error('Delete the existing file before creating another. Your draft is retained.');
    const value = text.value, prepared = await prepare(value, 'file');
    if (text.value !== value || !sameView()) throw Error('Draft or target changed. Confirm again.');
    saved = { ...await api('file', { receipt: prepared.receipt, text: value }), draft: value }; confirmed = null;
    status.textContent = 'Private file created for one hour. Copy its path or confirm the target, then insert the path. The AI must be asked to read it.';
  }));
  action('delete').addEventListener('click', () => run(async () => { await api('delete', { fileId: saved.fileId }); saved = null; confirmed = null; status.textContent = 'Context file deleted. Draft retained.'; }));
  action('confirm').addEventListener('click', () => run(async () => { const value = insertion(); const prepared = await prepare(value, 'insert'); if (insertion() !== value || !sameView() || !savedCurrent()) throw Error('Draft or target changed. Confirm again.'); confirmed = { ...prepared, text: value }; status.textContent = 'Target confirmed for 60 seconds. Insert sends this single line without Enter. Any terminal application may interpret input; check the target.'; }));
  action('insert').addEventListener('click', () => run(async () => {
    const input = confirmed; confirmed = null; terminalUncertain = true; render();
    if (!input || !sameView() || !savedCurrent() || insertion() !== input.text) throw Error('Draft or target changed. Nothing sent.');
    try { await api('insert', { receipt: input.receipt, text: input.text }); status.textContent = 'Inserted once without Enter. Managed AI remains paused. Check the terminal before pressing Enter; Resume sharing separately.'; }
    catch { status.textContent = 'Delivery is unconfirmed. Do not retry automatically. Check the terminal before reopening this editor. Draft retained.'; }
  }));
  action('recapture').addEventListener('click', () => { void open(); });
  action('cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { editorEpoch++; composing = false; confirmed = captured = null; const visible = button.checkVisibility ? button.checkVisibility() : !button.closest('details:not([open])'); const destination = visible ? button : document.querySelector('#toolbar-menu > summary'); destination?.focus(); });
  function resize() { if (!dialog.open) return; dialog.style.setProperty('--context-height', `${window.visualViewport?.height || window.innerHeight}px`); dialog.style.setProperty('--context-top', `${window.visualViewport?.offsetTop || 0}px`); }
  window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize); window.addEventListener('resize', resize);
  const timer = setInterval(() => { if (dialog.open) { if (captured && !sameView()) { confirmed = null; status.textContent = 'Terminal view changed or disconnected. Draft retained. Reopen to capture the intended target.'; } render(); } }, 250);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return { button };
};
