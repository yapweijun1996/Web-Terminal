'use strict';
const tabs = document.querySelector('#tabs');
const views = document.querySelector('#views');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const restore = document.querySelector('#restore');
const newTab = document.querySelector('#new-tab');
const latest = document.querySelector('#latest');
const imageResults = document.querySelector('#image-results');
const imageNotice = document.querySelector('#image-notice');
const copySelection = document.querySelector('#copy-selection');
const storageKey = 'linux-web-terminal-hidden-v1';
let hidden;
try { hidden = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch { hidden = new Set(); }
let sessions = [], active = null, token = '';
let focusVersion = 0;
let copyGestureAt = 0, pendingCopy = null;
let retryMode = null, loading = false, sessionReady = false, creating = false;
const frames = new Map();
const connections = new Map();
function label(name) { return name === 'shared' ? 'Existing terminal' : `Terminal ${name.slice(-4)}`; }
function saveHidden() { try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); } catch {} }
function updateControls() {
  newTab.disabled = !sessionReady || creating;
  latest.disabled = !sessionReady || !active;
}
function showStatus(message, retryAction = null) {
  status.textContent = message;
  status.title = 'Connection status only; background job status is unknown.';
  status.setAttribute('aria-label', `${message}. Background job status is unknown.`);
  retryMode = retryAction;
  retry.hidden = retryMode === null;
}
function showConnection(name) {
  const state = connections.get(name) || 'Connecting';
  if (state === 'Disconnected' || state === 'Connection error') return showStatus('Disconnected — retry or sign in', 'frame');
  showStatus(state);
}
function activate(name) {
  if (name !== active) { focusVersion++; copyGestureAt = 0; pendingCopy = null; copySelection.hidden = true; }
  active = name;
  if (!frames.has(name)) {
    const iframe = document.createElement('iframe');
    iframe.src = `/terminal/${name}`; iframe.title = label(name);
    iframe.addEventListener('load', () => installClipboard(iframe, name));
    views.append(iframe); frames.set(name, iframe);
  }
  for (const [id, iframe] of frames) iframe.classList.toggle('active', id === name);
  showConnection(name);
  renderTabs();
  updateControls();
}
function installClipboard(iframe, name) {
  const win = iframe.contentWindow;
  win.addEventListener('blur', () => { focusVersion++; });
  win.addEventListener('pointerup', () => { if (name === active) copyGestureAt = Date.now(); }, true);
  win.addEventListener('keydown', event => {
    if (name === active && event.ctrlKey && event.key.toLowerCase() === 'c') copyGestureAt = Date.now();
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'v') event.stopImmediatePropagation();
  }, true);
  win.addEventListener('paste', event => {
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const file = item.getAsFile();
    if (file) uploadImage(file, name, iframe);
  }, true);
  installDrop(win, () => ({ name, iframe }));
}
function installDrop(target, getTarget) {
  target.addEventListener('dragover', event => {
    if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  target.addEventListener('drop', event => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const file = event.dataTransfer.files[0]; const { name, iframe } = getTarget();
    if (file && name && iframe) uploadImage(file, name, iframe);
  }, true);
}
async function uploadImage(file, name, iframe) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { showImageNotice('Use a PNG, JPEG or WebP image'); return; }
  if (!file.size || file.size > 10 * 1024 * 1024) { showImageNotice('Image must be 10 MB or less'); return; }
  const observed = connections.get(name) === 'Connected' ? iframe.contentWindow?.webTerminalTarget : null;
  const input = observed?.session === name ? { ...observed } : null;
  const controlHeaders = { 'Content-Type': 'application/json', 'X-Terminal-Request': token };
  let receipt;
  try {
    showImageNotice('Identifying image target');
    const prepared = await fetch('/api/images/prepare', { method: 'POST', headers: { ...controlHeaders,
      'X-Terminal-Session': input?.session || '', 'X-Terminal-Session-Id': input?.sessionId || '',
      'X-Terminal-Pane': input?.pane || '', 'X-Terminal-Server-Pid': input?.serverPid || '' } });
    if (!prepared.ok) throw Error('Receipt unavailable');
    receipt = await prepared.json();
    if (!/^[a-f0-9]{48}$/.test(receipt.ticket)) throw Error('Invalid receipt');
    showImageNotice('Uploading image');
  } catch { showImageNotice('Unable to start upload safely; check the connection and retry'); return; }
  try {
    const response = await fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Terminal-Request': token, 'X-Image-Receipt': receipt.ticket }, body: file });
    if (!response.ok) { showImageNotice('Image upload failed'); return; }
    const data = await response.json();
    if (typeof data.path !== 'string' || !/^\/[^\x00-\x1f]*\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(data.path)) throw Error('Invalid image path');
    showSavedImage(data.path, receipt, name, iframe);
  } catch { showImageRecovery(receipt, name, iframe); }
}
installDrop(window, () => ({ name: active, iframe: frames.get(active) }));
function showImageNotice(text) { imageNotice.textContent = text; imageNotice.hidden = !text; }
function showSavedImage(path, receipt, name, iframe) {
  const item = document.createElement('div');
  const message = document.createElement('div'); message.setAttribute('role', 'status');
  message.textContent = receipt.target
    ? `Saved image. Captured ${label(name)}, window ${receipt.target.windowIndex}, pane ${receipt.target.paneIndex}. Check before inserting.`
    : 'Image saved. Target unavailable; copy its path.';
  const field = document.createElement('input'); field.readOnly = true; field.value = path; field.setAttribute('aria-label', 'Saved image path');
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy path';
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(path); message.textContent = 'Image path copied'; }
    catch { field.focus(); field.select(); message.textContent = 'Select and copy the image path'; }
  };
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.onclick = () => item.remove();
  item.append(message, field, copy, dismiss);
  if (receipt.target) {
    const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = 'Insert into captured pane';
    insert.onclick = async () => {
      if (frames.get(name) !== iframe || connections.get(name) !== 'Connected') { message.textContent = 'The captured view is unavailable. Copy the path.'; return; }
      insert.disabled = true;
      try {
        const response = await fetch('/api/images/insert', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token, 'X-Image-Receipt': receipt.ticket } });
        message.textContent = response.ok ? 'Path sent to the captured pane. Check it before continuing.' : 'Insertion not confirmed. Check the captured pane; the path is available to copy.';
      } catch { message.textContent = 'Insertion result unknown. Check the captured pane before retrying; the path is available to copy.'; }
    };
    item.append(insert);
  }
  imageResults.append(item); showImageNotice('');
}
function showImageRecovery(receipt, name, iframe) {
  showImageNotice('');
  const item = document.createElement('div'), message = document.createElement('div'), recover = document.createElement('button');
  message.setAttribute('role', 'status'); message.textContent = 'Upload interrupted. Recover the saved path within ten minutes.';
  recover.type = 'button'; recover.textContent = 'Recover saved path';
  recover.onclick = async () => {
    recover.disabled = true;
    try {
      const response = await fetch('/api/images/result', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token, 'X-Image-Receipt': receipt.ticket } });
      if (!response.ok) throw Error('Receipt unavailable');
      const data = await response.json();
      if (data.state === 'saved' && typeof data.path === 'string' && /^\/[^\x00-\x1f]*\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(data.path)) {
        showSavedImage(data.path, data.attempted ? { ...receipt, target: null } : receipt, name, iframe); item.remove(); return;
      }
      message.textContent = data.state === 'failed' ? 'The image was not saved. Upload again.' : 'The save is not confirmed yet. Try recovery again.';
    } catch { message.textContent = 'Recovery unavailable. Check the connection and retry; receipts expire after ten minutes.'; }
    finally { recover.disabled = false; }
  };
  item.append(message, recover); imageResults.append(item);
}
async function copyTerminalSelection(selection) {
  try {
    await navigator.clipboard.writeText(selection.text);
    if (pendingCopy === selection) { pendingCopy = null; copySelection.hidden = true; }
    status.textContent = 'Selection copied';
  } catch { status.textContent = 'Click Copy selection and allow clipboard access'; }
}
copySelection.addEventListener('click', () => { if (pendingCopy) copyTerminalSelection(pendingCopy); });
function renderTabs() {
  tabs.replaceChildren();
  for (const name of sessions.filter(n => !hidden.has(n))) {
    const group = document.createElement('div'); group.className = `tab${name === active ? ' active' : ''}`;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = label(name);
    open.setAttribute('aria-pressed', String(name === active)); open.addEventListener('click', () => activate(name));
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide'; hide.textContent = '×';
    hide.setAttribute('aria-label', `Hide ${label(name)}`); hide.title = 'Hide tab; keep session running';
    hide.addEventListener('click', () => {
      if (name === active) { pendingCopy = null; copySelection.hidden = true; }
      hidden.add(name); saveHidden(); frames.get(name)?.remove(); frames.delete(name);
      const next = sessions.find(n => !hidden.has(n)); if (next) activate(next); else { active = null; renderTabs(); updateControls(); }
    });
    group.append(open, hide); tabs.append(group);
  }
  restore.hidden = !sessions.some(n => hidden.has(n));
}
async function load() {
  if (loading) return;
  loading = true;
  sessionReady = false;
  updateControls();
  let authRequired = false;
  showStatus('Connecting');
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store', redirect: 'manual' });
    authRequired = response.status === 401 || response.status === 403 || response.type === 'opaqueredirect' || response.redirected;
    if (authRequired) throw Error('Authentication may be required');
    if (!response.ok) throw Error('Unable to load terminals');
    const data = await response.json(); sessions = data.sessions; token = data.token; sessionReady = true;
    const first = sessions.includes(active) && !hidden.has(active) ? active : sessions.find(n => !hidden.has(n));
    if (first) activate(first); else renderTabs();
    if (!first) { showStatus('No visible terminals'); updateControls(); }
  } catch { showStatus(authRequired ? 'Sign-in may be required' : 'Connection unavailable — retry or sign in', 'load'); }
  finally { loading = false; }
}
retry.addEventListener('click', () => {
  status.focus();
  if (retryMode === 'load') { void load(); return; }
  const name = active;
  if (retryMode !== 'frame' || !name || !frames.has(name)) return;
  frames.get(name).remove();
  frames.delete(name);
  focusVersion++; copyGestureAt = 0; pendingCopy = null; copySelection.hidden = true;
  connections.set(name, 'Connecting');
  activate(name);
});
newTab.addEventListener('click', async () => {
  if (!sessionReady || creating) return;
  creating = true; updateControls();
  try {
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token }, body: '{}' });
    if (!response.ok) throw Error('Unable to create terminal');
    const data = await response.json(); sessions.push(data.name); activate(data.name);
  } catch { sessionReady = false; showStatus('Unable to create terminal — check connection or sign in', 'load'); } finally { creating = false; updateControls(); }
});
restore.addEventListener('click', () => { hidden.clear(); saveHidden(); renderTabs(); if (!active && sessions.length) activate(sessions[0]); });
latest.addEventListener('click', async () => {
  if (!sessionReady || !active) return;
  try {
    const response = await fetch(`/api/sessions/${active}/latest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token }, body: '{}' });
    if (!response.ok) throw Error('Unable to return to latest output');
    frames.get(active)?.contentWindow?.focus();
  } catch { sessionReady = false; updateControls(); showStatus('Unable to return to latest output — check connection or sign in', 'load'); }
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  for (const [name, iframe] of frames) {
    if (event.source === iframe.contentWindow) {
      if (event.data?.type === 'terminal-connection' && ['Connecting', 'Connected', 'Disconnected', 'Connection error'].includes(event.data.state)) {
        connections.set(name, event.data.state);
        if (name === active) showConnection(name);
      } else if (event.data?.type === 'terminal-clipboard' && name === active && typeof event.data.text === 'string' && event.data.text.length > 0 && event.data.text.length <= 1048576) {
        const selection = { name, text: event.data.text };
        pendingCopy = selection; copySelection.hidden = false;
        if (Date.now() - copyGestureAt < 1500 && document.activeElement === iframe && document.hasFocus()) copyTerminalSelection(selection);
        else status.textContent = 'Selection ready; click Copy selection';
      }
      break;
    }
  }
});
load();
