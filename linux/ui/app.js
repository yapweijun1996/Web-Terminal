'use strict';
const tabs = document.querySelector('#tabs');
const views = document.querySelector('#views');
const status = document.querySelector('#status');
const detailView = document.querySelector('#detail-view');
const detailLink = document.querySelector('#detail-link');
const scrollStatus = document.querySelector('#scroll-status');
const retry = document.querySelector('#retry');
const restore = document.querySelector('#restore');
const newTab = document.querySelector('#new-tab');
const renameTab = document.querySelector('#rename-tab');
renameTab.setAttribute('aria-keyshortcuts', 'Control+Alt+Shift+T');
renameTab.title = 'Press Control+Alt+Shift+T in the terminal to focus this toolbar.';
const renameForm = document.querySelector('#rename-form');
const renameInput = document.querySelector('#rename-input');
const renameCancel = document.querySelector('#rename-cancel');
const renameError = document.querySelector('#rename-error');
const latest = document.querySelector('#latest');
const imageResults = document.querySelector('#image-results');
const imageNotice = document.querySelector('#image-notice');
const copySelection = document.querySelector('#copy-selection');
const storageKey = 'linux-web-terminal-hidden-v1';
const namesKey = 'linux-web-terminal-names-v1';
let hidden;
try { hidden = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch { hidden = new Set(); }
let names = {};
try {
  const saved = JSON.parse(localStorage.getItem(namesKey) || '{}');
  for (const [id, value] of Object.entries(saved)) {
    if (/^(shared|web-[a-f0-9]{12})$/.test(id) && typeof value === 'string' && value.trim() && value.length <= 40 && !/[\x00-\x1f\x7f]/.test(value)) names[id] = value.trim();
  }
} catch {}
let sessions = [], active = null, token = '';
let copyGestureAt = 0, pendingCopy = null;
let retryMode = null, loading = false, sessionReady = false, creating = false, returning = false;
let renameTarget = null;
let closeSequence = 0;
const frames = new Map();
const connections = new Map();
const scrollModes = new Map();
const mobileKeys = window.createMobileKeys({
  getTerminal: () => active && connections.get(active) === 'Connected' && frames.get(active)?.contentWindow?.webTerminalTarget ? frames.get(active)?.contentWindow?.term : null,
  getTargetKey: () => {
    const target = active && connections.get(active) === 'Connected' && frames.get(active)?.contentWindow?.webTerminalTarget;
    return target ? [target.session, target.sessionId, target.pane, target.serverPid].join('|') : null;
  },
});
latest.before(mobileKeys.toggle);
views.before(mobileKeys.panel);
const displayControls = window.createTerminalDisplayControls({
  getTerminal: () => active && connections.get(active) === 'Connected' ? frames.get(active)?.contentWindow?.term : null,
  fit: () => {
    const win = frames.get(active)?.contentWindow;
    if (win) win.dispatchEvent(new win.Event('resize'));
  },
});
latest.before(displayControls.element);
function label(name) { return names[name] || (name === 'shared' ? 'Existing terminal' : `Terminal ${name.slice(4)}`); }
function saveHidden() { try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); } catch {} }
function saveNames() { try { localStorage.setItem(namesKey, JSON.stringify(names)); return true; } catch { return false; } }
function updateControls() {
  newTab.disabled = !sessionReady || creating;
  latest.disabled = !sessionReady || !active || returning;
  renameTab.disabled = !sessionReady || !active;
}
function showStatus(message, retryAction = null, link = message) {
  status.textContent = message;
  detailLink.textContent = link;
  status.title = 'Connection status only; background job status is unknown.';
  status.setAttribute('aria-label', `${message}. Background job status is unknown.`);
  retryMode = retryAction;
  retry.hidden = retryMode === null;
}
function showConnection(name) {
  const state = connections.get(name) || 'Connecting';
  showScroll(name);
  if (state === 'Disconnected' || state === 'Connection error') return showStatus('Disconnected — retry or sign in', 'frame');
  showStatus(state);
}
function showScroll(name) {
  const mode = connections.get(name) === 'Connected' ? scrollModes.get(name) : null;
  const state = mode == null ? 'tmux scroll unknown' : /^copy-mode/.test(mode) ? 'tmux scrollback' : mode ? 'tmux mode unknown' : 'tmux live';
  scrollStatus.textContent = `${state}; app scroll unknown`;
  scrollStatus.title = 'This reports tmux mode only; the application may have its own scroll position.';
}
function activate(name, focusTab = false) {
  if (renameTarget && renameTarget !== name) { renameForm.hidden = true; renameTarget = null; renameError.textContent = ''; }
  if (name !== active) { copyGestureAt = 0; pendingCopy = null; copySelection.hidden = true; }
  active = name;
  mobileKeys.resetIfTargetChanged();
  const visible = sessions.filter(session => !hidden.has(session));
  detailView.textContent = `${visible.indexOf(name) + 1} of ${visible.length}`;
  if (!frames.has(name)) {
    connections.set(name, 'Connecting');
    scrollModes.delete(name);
    const iframe = document.createElement('iframe');
    iframe.src = `/terminal/${name}`; iframe.title = label(name);
    iframe.dataset.preserveTabFocus = String(focusTab);
    iframe.addEventListener('load', () => installClipboard(iframe, name));
    views.append(iframe); frames.set(name, iframe);
  }
  for (const [id, iframe] of frames) iframe.classList.toggle('active', id === name);
  showConnection(name);
  displayControls.apply();
  renderTabs(focusTab ? name : null);
  updateControls();
}
function installClipboard(iframe, name) {
  const win = iframe.contentWindow;
  win.addEventListener('pointerup', () => { if (name === active) copyGestureAt = Date.now(); }, true);
  win.addEventListener('keydown', event => {
    if (name === active && frames.get(name) === iframe && event.code === 'KeyT' && event.altKey && event.shiftKey && event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopImmediatePropagation(); renameTab.focus(); return;
    }
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
function removeView(name) {
  if (name === active) { pendingCopy = null; copySelection.hidden = true; }
  frames.get(name)?.remove(); frames.delete(name); connections.delete(name); scrollModes.delete(name);
  const next = active && sessions.includes(active) && !hidden.has(active) ? active : sessions.find(n => !hidden.has(n));
  if (next) activate(next, true);
  else { active = null; detailView.textContent = 'Unknown'; showStatus('No visible terminals', null, 'Unknown'); renameTarget = null; renameForm.hidden = true; renameError.textContent = ''; renderTabs(); updateControls(); (restore.hidden ? newTab : restore).focus(); }
}
function confirmClose(name, opener) {
  const sequence = ++closeSequence;
  const dialog = document.querySelector('#close-dialog');
  const title = document.querySelector('#close-name');
  const error = document.querySelector('#close-error');
  const confirm = document.querySelector('#close-confirm');
  const cancel = document.querySelector('#close-cancel');
  const dismiss = document.querySelector('#close-dismiss');
  const hide = document.querySelector('#close-hide');
  let identity = null, closing = false;
  title.textContent = `${label(name)} (${name})`;
  error.textContent = '';
  confirm.disabled = true; cancel.disabled = false; dismiss.disabled = false; hide.disabled = false;
  const cancelDialog = () => { if (!closing) { dialog.close(); opener.focus(); } };
  cancel.onclick = cancelDialog; dismiss.onclick = cancelDialog;
  dialog.oncancel = event => { event.preventDefault(); cancelDialog(); };
  hide.onclick = () => {
    if (closing) return;
    dialog.close(); hidden.add(name); saveHidden(); removeView(name);
  };
  confirm.onclick = async () => {
    if (!identity || closing) return;
    closing = true; confirm.disabled = true; cancel.disabled = true; dismiss.disabled = true; hide.disabled = true;
    try {
      const response = await fetch(`/api/sessions/${name}/close`, { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-Terminal-Request': token,
        'X-Terminal-Session-Id': identity.sessionId, 'X-Terminal-Server-Pid': identity.serverPid,
      } });
      if (!response.ok) throw Error('Session could not be ended');
      dialog.close(); sessions = sessions.filter(session => session !== name);
      hidden.delete(name); saveHidden(); delete names[name]; saveNames(); removeView(name);
    } catch {
      error.textContent = 'Session end was not confirmed. Refresh the page before trying again.';
      identity = null; cancel.disabled = false; dismiss.disabled = false; hide.disabled = false;
    } finally { closing = false; }
  };
  dialog.showModal(); cancel.focus();
  fetch(`/api/sessions/${name}/identity`, { cache: 'no-store', redirect: 'manual' })
    .then(response => { if (!response.ok) throw Error('Session unavailable'); return response.json(); })
    .then(data => {
      if (!/^\$\d+$/.test(data.sessionId) || !/^\d+$/.test(data.serverPid)) throw Error('Session unavailable');
      if (dialog.open && sequence === closeSequence) { identity = data; confirm.disabled = false; }
    })
    .catch(() => { if (dialog.open && sequence === closeSequence) error.textContent = 'Session identity unavailable. Refresh and try again.'; });
}
function renderTabs(focusName = null) {
  let focusTarget = null;
  tabs.replaceChildren();
  const visible = sessions.filter(n => !hidden.has(n));
  for (const name of visible) {
    const group = document.createElement('div'); group.className = `tab${name === active ? ' active' : ''}`;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = label(name);
    open.setAttribute('aria-pressed', String(name === active)); open.addEventListener('click', event => activate(name, event.detail === 0));
    open.addEventListener('keydown', event => {
      const index = visible.indexOf(name);
      const next = event.key === 'ArrowRight' ? visible[(index + 1) % visible.length]
        : event.key === 'ArrowLeft' ? visible[(index - 1 + visible.length) % visible.length]
          : event.key === 'Home' ? visible[0] : event.key === 'End' ? visible[visible.length - 1] : null;
      if (next) { event.preventDefault(); activate(next, true); }
    });
    if (name === focusName) focusTarget = open;
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide'; hide.textContent = '×';
    hide.setAttribute('aria-label', `Close ${label(name)}`); hide.title = 'Close or hide terminal';
    hide.addEventListener('click', () => confirmClose(name, hide));
    group.append(open, hide); tabs.append(group);
  }
  restore.hidden = !sessions.some(n => hidden.has(n));
  if (focusTarget) { focusTarget.focus(); focusTarget.scrollIntoView({ block: 'nearest', inline: 'center' }); }
}
renameTab.addEventListener('click', () => {
  if (!active) return;
  renameTarget = active;
  renameInput.value = names[active] || '';
  renameInput.placeholder = label(active);
  renameError.textContent = '';
  renameForm.hidden = false;
  renameInput.focus(); renameInput.select();
});
function cancelRename() { renameForm.hidden = true; renameTarget = null; renameError.textContent = ''; renameTab.focus(); }
renameCancel.addEventListener('click', cancelRename);
renameForm.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); cancelRename(); } });
renameForm.addEventListener('submit', event => {
  event.preventDefault();
  if (!active || renameTarget !== active) return;
  const value = renameInput.value.trim();
  if (value.length > 40 || /[\x00-\x1f\x7f]/.test(value)) { renameError.textContent = 'Use up to 40 printable characters.'; return; }
  const display = value || (active === 'shared' ? 'Existing terminal' : `Terminal ${active.slice(4)}`);
  if (sessions.some(name => name !== active && label(name).toLocaleLowerCase() === display.toLocaleLowerCase())) {
    renameError.textContent = 'Choose a name that is different from the other views.'; return;
  }
  const previous = names[active];
  if (value) names[active] = value; else delete names[active];
  if (!saveNames()) {
    if (previous) names[active] = previous; else delete names[active];
    renameError.textContent = 'Unable to save names in this browser.'; return;
  }
  const frame = frames.get(active); if (frame) frame.title = label(active);
  renderTabs(); cancelRename();
});
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
    if (!first) { detailView.textContent = 'Unknown'; showStatus('No visible terminals', null, 'Unknown'); updateControls(); }
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
  copyGestureAt = 0; pendingCopy = null; copySelection.hidden = true;
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
  } catch { sessionReady = false; showStatus('Unable to create terminal — check connection or sign in', 'load', connections.get(active) || 'Unknown'); } finally { creating = false; updateControls(); }
});
restore.addEventListener('click', event => { hidden.clear(); saveHidden(); renderTabs(); if (!active && sessions.length) activate(sessions[0], event.detail === 0); });
latest.addEventListener('click', async () => {
  if (!sessionReady || !active || returning) return;
  const name = active, iframe = frames.get(name);
  const target = connections.get(name) === 'Connected' ? iframe?.contentWindow?.webTerminalTarget : null;
  if (!target || target.session !== name) { scrollStatus.textContent = 'tmux scroll target unavailable; app scroll unknown'; return; }
  returning = true; updateControls();
  try {
    const response = await fetch(`/api/sessions/${name}/latest`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Terminal-Request': token,
      'X-Terminal-Session': target.session, 'X-Terminal-Session-Id': target.sessionId,
      'X-Terminal-Pane': target.pane, 'X-Terminal-Server-Pid': target.serverPid,
    }, body: '{}' });
    if (!response.ok) throw Error('Unable to return to latest output');
  } catch { if (active === name) scrollStatus.textContent = 'tmux scroll unavailable; app scroll unknown'; }
  finally { returning = false; updateControls(); }
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin) return;
  for (const [name, iframe] of frames) {
    if (event.source === iframe.contentWindow) {
      if (event.data?.type === 'terminal-connection' && ['Connecting', 'Connected', 'Disconnected', 'Connection error'].includes(event.data.state)) {
        connections.set(name, event.data.state);
        if (event.data.state !== 'Connected') scrollModes.delete(name);
        if (event.data.state === 'Connected') iframe.contentWindow?.term?.textarea?.setAttribute('aria-label', 'Terminal input. Press Control Alt Shift T to focus toolbar.');
        if (name === active && event.data.state !== 'Connected') mobileKeys.reset();
        if (name === active && event.data.state === 'Connected') displayControls.apply();
        if (name === active) showConnection(name);
      } else if (event.data?.type === 'terminal-scroll' && (event.data.mode === null || (typeof event.data.mode === 'string' && /^[a-z0-9-]{0,64}$/.test(event.data.mode)))) {
        scrollModes.set(name, event.data.mode);
        if (name === active) mobileKeys.resetIfTargetChanged();
        if (name === active) showScroll(name);
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
