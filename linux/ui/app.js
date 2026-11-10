'use strict';
// Mobile viewport adapter: shipped in the existing hot-served outer asset.
const terminalViewport = (() => {
  // Small DOM fixtures and browsers without media queries retain normal layout.
  if (!window.matchMedia || !window.requestAnimationFrame) return { install() {}, forget() {} };
  const touch = window.matchMedia('(any-pointer: coarse)');
  const viewport = window.visualViewport;
  const installed = new WeakMap();
  function forget(iframe) { installed.get(iframe)?.cleanup(); installed.delete(iframe); }
  function install(iframe) {
    // The existing /terminal/<session> proxy is same-origin. Do not relax it.
    let win, term;
    try { win = iframe.contentWindow; term = win?.term; } catch { return; }
    if (!term?.textarea || !term.element) return;
    if (installed.get(iframe)?.term === term) return;
    forget(iframe);
    const cleanups = [];
    let disposed = false;
    const originalResize = term.resize;
    const resize = originalResize.bind(term);
    cleanups.push(() => { term.resize = originalResize; });
    term.resize = (cols, rows) => {
      const buffer = term.buffer?.active;
      const line = touch.matches && buffer?.type === 'normal' && buffer.viewportY < buffer.baseY && cols === term.cols ? buffer.viewportY : null;
      // A full scrollback buffer can trim its first lines when rows shrink.
      // Public markers follow that trim, keeping the same surviving history.
      const marker = line === null ? null : term.registerMarker?.(line - buffer.baseY - buffer.cursorY);
      try {
        resize(cols, rows);
        if (line !== null && term.buffer.active === buffer && !marker?.isDisposed) term.scrollToLine(marker?.line ?? line);
      } finally { marker?.dispose(); }
    };
    const input = term.textarea;
    if (input) {
      const originalFocus = input.focus;
      const originalFontSize = input.style.fontSize;
      const focus = originalFocus.bind(input);
      cleanups.push(() => { input.focus = originalFocus; input.style.fontSize = originalFontSize; });
      input.focus = options => focus(touch.matches ? { ...options, preventScroll: true } : options);
      const updateInput = () => { input.style.fontSize = touch.matches ? '16px' : ''; };
      touch.addEventListener('change', updateInput);
      cleanups.push(() => touch.removeEventListener('change', updateInput));
      updateInput();
    }
    // ResizeObserver also covers parent toolbar/Keys/sidebar layout changes.
    let pending = false, geometry = '';
    const schedule = () => {
      if (pending) return;
      pending = true;
      win.requestAnimationFrame(() => {
        pending = false;
        if (disposed || !touch.matches || (viewport && Math.abs(viewport.scale - 1) > 0.01)) return;
        const box = term.element?.getBoundingClientRect();
        if (!box || box.width <= 0 || box.height <= 0) return;
        const next = `${box.width}|${box.height}`;
        if (next !== geometry) { geometry = next; term.fit?.(); }
      });
    };
    if (typeof win.ResizeObserver === 'function' && term.element) {
      const observer = new win.ResizeObserver(schedule);
      observer.observe(term.element);
      cleanups.push(() => observer.disconnect());
    }
    win.addEventListener('resize', schedule);
    cleanups.push(() => win.removeEventListener('resize', schedule));
    schedule();

    const cleanup = () => { disposed = true; for (const dispose of cleanups) dispose(); };
    const unload = () => forget(iframe);
    win.addEventListener('pagehide', unload, { once: true });
    cleanups.push(() => win.removeEventListener('pagehide', unload));
    installed.set(iframe, { term, cleanup });
  }
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      // Preserve accessibility zoom; a pinch is not a request to resize the PTY.
      if (touch.matches && viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height ?? window.innerHeight;
      if (touch.matches && (!Number.isFinite(height) || height <= 0)) return;
      document.body.classList.toggle('terminal-visual-viewport', touch.matches);
      const style = document.documentElement.style;
      if (touch.matches) {
        style.setProperty('--terminal-viewport-height', `${height}px`);
        style.setProperty('--terminal-viewport-top', `${Math.max(0, viewport?.offsetTop || 0)}px`);
      } else {
        style.removeProperty('--terminal-viewport-height');
        style.removeProperty('--terminal-viewport-top');
      }
    });
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pageshow', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  touch.addEventListener('change', schedule);
  schedule();
  return { install, forget };
})();
// End mobile viewport adapter.
const tabs = document.querySelector('#tabs');
const views = document.querySelector('#views');
const status = document.querySelector('#status');
const detailView = document.querySelector('#detail-view');
const detailLink = document.querySelector('#detail-link');
const scrollStatus = document.querySelector('#scroll-status');
const retry = document.querySelector('#retry');
const restore = document.querySelector('#restore');
const newTab = document.querySelector('#new-tab');
const newSession = document.querySelector('#new-session');
const reconnect = document.querySelector('#reconnect');
const currentName = document.querySelector('#current-name');
const currentSecondary = document.querySelector('#current-secondary');
const searchResults = document.querySelector('#search-results');
const renameTab = document.querySelector('#rename-tab');
const splitRight = document.querySelector('#split-right');
const splitDown = document.querySelector('#split-down');
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
let splitting = false;
const frames = new Map();
const connections = new Map();
let sessionDetails = {};
let metadataStale = false, tabViewKey = null;
let reportedSharing = null, reportedSharingSession = null, authentication = null;
function renderIndicators() {
  if (!window.TerminalStatus) return;
  const bar = document.querySelector('.status-bar');
  if (bar) bar.hidden = false;
  const connection = active ? connections.get(active)?.toLowerCase().replace('connection error', 'disconnected') : (loading ? 'connecting' : null);
  const session = active && !metadataStale && sessions.includes(active) && !missingPolls.has(active)
    ? { name: label(active), process: sessionDetails[active]?.command } : null;
  const indicators = window.TerminalStatus.deriveStatus({
    connection, session, auth: authentication,
    input: reportedSharingSession === active ? reportedSharing?.input : null,
    sharing: reportedSharingSession === active ? reportedSharing : null,
  });
  for (const [name, item] of Object.entries(indicators)) {
    const node = document.getElementById(`status-${name}`);
    if (!node) continue;
    node.dataset.level = item.level;
    node.textContent = `${item.icon} ${name[0].toUpperCase() + name.slice(1)}: ${item.label}`;
    node.title = item.detail;
    node.setAttribute('aria-label', `${name}: ${item.label}. ${item.detail}`);
  }
}
const missingPolls = new Map();
function foregroundStatus(name) {
  return metadataStale ? { state: 'Status unavailable', command: '' }
    : window.TerminalSidebar.sessionStatus(sessions.includes(name) && !missingPolls.has(name), connections.get(name), sessionDetails[name]?.command);
}
function foregroundText(foreground) {
  return `${foreground.state}${foreground.state === 'Running' && foreground.command ? ` · ${foreground.command}` : ''}`;
}
const sidebar = window.TerminalSidebar.create({
  getFrames: () => frames.values(),
  refit: () => {
    const win = frames.get(active)?.contentWindow;
    if (win) win.dispatchEvent(new win.Event('resize'));
  },
  onSearch: () => renderTabs(),
  onPrefsChange: () => renderTabs(),
});
const scrollModes = new Map();
const mobileKeys = window.createMobileKeys({
  getTerminal: () => active && connections.get(active) === 'Connected' && frames.get(active)?.contentWindow?.webTerminalTarget ? frames.get(active)?.contentWindow?.term : null,
  getTargetKey: () => {
    const target = active && connections.get(active) === 'Connected' && frames.get(active)?.contentWindow?.webTerminalTarget;
    return target ? [target.session, target.sessionId, target.pane, target.serverPid].join('|') : null;
  },
});
document.querySelector('#view-actions').append(mobileKeys.toggle);
views.before(mobileKeys.panel);
const displayControls = window.createTerminalDisplayControls({
  getTerminal: () => active && connections.get(active) === 'Connected' ? frames.get(active)?.contentWindow?.term : null,
  fit: () => {
    const win = frames.get(active)?.contentWindow;
    if (win) win.dispatchEvent(new win.Event('resize'));
  },
});
document.querySelector('#view-actions').append(displayControls.element);
const collaborationControls = window.createCollaborationControls?.({
  getSession: () => active, getToken: () => token,
  onState: (state, session) => { reportedSharing = state; reportedSharingSession = session; renderIndicators(); },
});
if (collaborationControls) {
  document.querySelector('#view-actions').append(collaborationControls.element);
  // The toolbar controls move into a closed menu on mobile. Keep failures
  // visible outside that menu, where polling and focus changes cannot hide them.
  document.querySelector('header').append(collaborationControls.notice);
}
const contextPaste = window.createContextPaste?.({ getSession: () => active, getToken: () => token,
  getTarget: () => active && connections.get(active) === 'Connected' ? frames.get(active)?.contentWindow?.webTerminalTarget : null });
if (contextPaste) document.querySelector('#session-actions').append(contextPaste.button);
function label(name) { return names[name] || (name === 'shared' ? 'Existing terminal' : `Terminal ${name.slice(4)}`); }
function saveHidden() { try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); } catch {} }
function saveNames() { try { localStorage.setItem(namesKey, JSON.stringify(names)); return true; } catch { return false; } }
function splitTarget() {
  const target = active && connections.get(active) === 'Connected' ? frames.get(active)?.contentWindow?.webTerminalTarget : null;
  return target?.session === active && /^\$\d+$/.test(target.sessionId) && /^\d+$/.test(target.serverPid) ? target : null;
}
function updateControls() {
  newTab.disabled = !sessionReady || creating;
  newSession.disabled = newTab.disabled;
  reconnect.disabled = loading || (!active && retryMode !== 'load');
  latest.disabled = !sessionReady || !active || returning;
  renameTab.disabled = !sessionReady || !active;
  const splitReason = splitting ? 'Split in progress' : !sessionReady || !splitTarget() ? 'Connect a terminal with a known session identity to split' : '';
  for (const button of [splitRight, splitDown]) {
    button.disabled = Boolean(splitReason);
    button.title = splitReason;
  }
  currentName.textContent = active ? label(active) : 'No session';
  const foreground = foregroundStatus(active);
  currentSecondary.textContent = foregroundText(foreground);
  renderIndicators();
}
function showStatus(message, retryAction = null, link = message) {
  status.textContent = message;
  status.classList.toggle('sr-only', ['Connected', 'Connecting', 'Reconnecting', 'Disconnected — retry or sign in', 'Sign-in may be required'].includes(message));
  detailLink.textContent = link;
  status.title = 'Connection status only; background job status is unknown.';
  status.setAttribute('aria-label', `${message}. Background job status is unknown.`);
  retryMode = retryAction;
  renderIndicators();
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
  reportedSharing = null; reportedSharingSession = null;
  collaborationControls?.refresh();
  mobileKeys.resetIfTargetChanged();
  const visible = sessions.filter(session => !hidden.has(session));
  detailView.textContent = `${visible.indexOf(name) + 1} of ${visible.length}`;
  if (!frames.has(name)) {
    if (!connections.has(name)) connections.set(name, 'Connecting');
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
  sidebar.applyTheme();
  sidebar.refit();
  updateControls();
}
function installClipboard(iframe, name) {
  terminalViewport.install(iframe);
  const win = iframe.contentWindow;
  win.addEventListener('pointerup', () => { if (name === active) copyGestureAt = Date.now(); }, true);
  win.addEventListener('keydown', event => {
    if (name === active && frames.get(name) === iframe && event.code === 'KeyT' && event.altKey && event.shiftKey && event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopImmediatePropagation(); document.querySelector('#toolbar-menu').open = true; renameTab.focus(); return;
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
  terminalViewport.forget(frames.get(name));
  frames.get(name)?.remove(); frames.delete(name); connections.delete(name); scrollModes.delete(name);
  const next = active && sessions.includes(active) && !hidden.has(active) ? active : sessions.find(n => !hidden.has(n));
  if (next) activate(next, true);
  else {
    active = null; detailView.textContent = 'Unknown'; showStatus('No visible terminals', null, 'Unknown');
    renameTarget = null; renameForm.hidden = true; renameError.textContent = '';
    renderTabs(); updateControls(); sidebar.closeDrawer(false);
    if (!restore.hidden || sidebar.isNarrow()) document.querySelector('#toolbar-menu').open = true;
    (restore.hidden ? newSession : restore).focus();
  }
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
  const cancelDialog = () => {
    if (closing) return;
    dialog.close();
    if (opener.isConnected !== false && opener.getClientRects().length) opener.focus();
    else {
      const fallback = ['#sidebar-close', '#sidebar-toggle'].map(selector => document.querySelector(selector))
        .find(element => element?.getClientRects().length);
      fallback?.focus();
    }
  };
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
  // Polls must not replace the keyboard user's focused sidebar control.
  const focused = document.activeElement;
  const focusSession = tabs.contains(focused) ? focused?.dataset?.session : null;
  const focusAction = tabs.contains(focused) ? focused?.dataset?.action : null;
  const focusRow = target => {
    if (!target) return;
    if (sidebar.isNarrow() && !sidebar.isDrawerOpen()) status.focus();
    else { target.focus(); target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  };
  const pins = sidebar.prefs.pins;
  const query = document.querySelector('#session-search').value || '';
  const visible = window.TerminalSidebar.orderSessions(sessions.filter(n => !hidden.has(n)), pins, label, query);
  const view = visible.map(name => [name, label(name), foregroundText(foregroundStatus(name)), pins.includes(name), connections.get(name)]);
  const mobileVisible = window.TerminalSidebar.orderSessions(sessions.filter(n => !hidden.has(n)), pins, label);
  const key = JSON.stringify([view, mobileVisible.map(name => [name, label(name), connections.get(name)]), active, sidebar.prefs.collapsed, query]);
  restore.hidden = !sessions.some(n => hidden.has(n));
  updateControls();
  if (key === tabViewKey) {
    if (focusName) focusRow(tabs.querySelector(`[data-session="${focusName}"][data-action="open"]`));
    return;
  }
  tabViewKey = key;
  const mobileTabs = document.getElementById('mobile-session-tabs');
  if (mobileTabs) {
    const mobileFocus = mobileTabs.contains(focused) ? focused?.dataset?.session : null;
    mobileTabs.replaceChildren();
    for (const name of mobileVisible) {
      const button = document.createElement('button');
      button.type = 'button'; button.dataset.session = name;
      button.setAttribute('aria-pressed', String(name === active));
      const state = window.TerminalStatus?.deriveStatus({ connection: connections.get(name)?.toLowerCase().replace('connection error', 'disconnected') }).connection;
      const dot = document.createElement('span'); dot.className = 'session-dot'; dot.dataset.level = state?.level || 'unknown';
      dot.textContent = state?.icon || '?'; dot.setAttribute('aria-hidden', 'true');
      button.append(dot, document.createTextNode(label(name)));
      button.setAttribute('aria-label', `${label(name)}: ${state?.label || 'Not reported'}`);
      button.addEventListener('click', () => activate(name));
      button.addEventListener('keydown', event => {
        const index = mobileVisible.indexOf(name);
        const next = event.key === 'ArrowRight' ? mobileVisible[(index + 1) % mobileVisible.length]
          : event.key === 'ArrowLeft' ? mobileVisible[(index - 1 + mobileVisible.length) % mobileVisible.length]
            : event.key === 'Home' ? mobileVisible[0] : event.key === 'End' ? mobileVisible[mobileVisible.length - 1] : null;
        if (next) {
          event.preventDefault(); activate(next);
          mobileTabs.querySelector(`[data-session="${next}"]`)?.focus();
        }
      });
      mobileTabs.append(button);
      if (name === mobileFocus) button.focus();
      if (name === active) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  tabs.replaceChildren();
  const resultCount = `${visible.length} ${visible.length === 1 ? 'session' : 'sessions'} found`;
  if (searchResults.textContent !== resultCount) searchResults.textContent = resultCount;
  const navigable = visible.filter(name => query || !sidebar.prefs.collapsed[pins.includes(name) ? 'Pinned' : 'Sessions']);
  for (const section of ['Pinned', 'Sessions']) {
    const members = visible.filter(name => pins.includes(name) === (section === 'Pinned'));
    if (!members.length) continue;
    const heading = document.createElement('button');
    heading.type = 'button'; heading.className = 'session-group';
    heading.textContent = section;
    heading.dataset.session = section; heading.dataset.action = 'group';
    heading.setAttribute('aria-expanded', String(Boolean(query) || !sidebar.prefs.collapsed[section]));
    heading.addEventListener('click', () => {
      sidebar.prefs.collapsed[section] = !sidebar.prefs.collapsed[section];
      sidebar.save(); sidebar.refit();
    });
    tabs.append(heading);
    if (focusSession === section && focusAction === 'group') focusTarget = heading;
    for (const name of members) {
      const group = document.createElement('div'); group.className = `tab${name === active ? ' active' : ''}`;
      group.hidden = !query && Boolean(sidebar.prefs.collapsed[section]);
      const open = document.createElement('button'); open.type = 'button'; open.className = 'session-open';
      open.textContent = label(name);
      open.dataset.session = name; open.dataset.action = 'open';
      open.setAttribute('aria-pressed', String(name === active));
      open.addEventListener('click', event => {
        activate(name, event.detail === 0 || sidebar.isDrawerOpen());
        sidebar.closeDrawer();
      });
      open.addEventListener('keydown', event => {
        const index = navigable.indexOf(name);
        const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? navigable[(index + 1) % navigable.length]
          : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? navigable[(index - 1 + navigable.length) % navigable.length]
            : event.key === 'Home' ? navigable[0] : event.key === 'End' ? navigable[navigable.length - 1] : null;
        if (next) { event.preventDefault(); activate(next, true); }
      });
      const foreground = foregroundStatus(name);
      const state = document.createElement('span'); state.className = `session-state ${metadataStale ? 'stale' : foreground.state.toLowerCase()}`;
      state.textContent = foregroundText(foreground);
      const stateId = `session-state-${name}`; state.id = stateId;
      open.setAttribute('aria-describedby', stateId);
      const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'pin';
      pin.textContent = pins.includes(name) ? '◆' : '◇';
      pin.dataset.session = name; pin.dataset.action = 'pin';
      pin.setAttribute('aria-label', `Pin ${label(name)}`); pin.setAttribute('aria-pressed', String(pins.includes(name)));
      pin.addEventListener('click', () => {
        sidebar.prefs.pins = pins.includes(name) ? pins.filter(id => id !== name) : [...pins, name];
        sidebar.save();
      });
      const close = document.createElement('button'); close.type = 'button'; close.className = 'hide'; close.textContent = '×';
      close.dataset.session = name; close.dataset.action = 'close';
      close.setAttribute('aria-label', `Close ${label(name)}`); close.title = 'Close or hide terminal';
      close.addEventListener('click', () => confirmClose(name, close));
      group.append(open, pin, close, state); tabs.append(group);
      if (name === focusName) focusTarget = open;
      else if (!focusName && name === focusSession) focusTarget = group.hidden ? heading : focusAction === 'pin' ? pin : focusAction === 'close' ? close : open;
    }
  }
  focusRow(focusTarget);
}
renameTab.addEventListener('click', () => {
  document.querySelector('#toolbar-menu').open = false;
  if (!active) return;
  renameTarget = active;
  renameInput.value = names[active] || '';
  renameInput.placeholder = label(active);
  renameError.textContent = '';
  renameForm.hidden = false;
  renameInput.focus(); renameInput.select();
});
function cancelRename() {
  renameForm.hidden = true; renameTarget = null; renameError.textContent = '';
  document.querySelector('#toolbar-menu').open = true;
  renameTab.focus();
}
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
    const data = await response.json(); sessions = data.sessions; sessionDetails = data.details || {}; token = data.token; sessionReady = true; authentication = null;
    metadataStale = false; missingPolls.clear();
    const first = sessions.includes(active) && !hidden.has(active) ? active : sessions.find(n => !hidden.has(n));
    if (first) activate(first); else renderTabs();
    if (!first) { detailView.textContent = 'Unknown'; showStatus('No visible terminals', null, 'Unknown'); updateControls(); }
  } catch { authentication = authRequired ? 'auth-required' : null; showStatus(authRequired ? 'Sign-in may be required' : 'Connection unavailable — retry or sign in', 'load'); }
  finally { loading = false; updateControls(); }
}
// Poll metadata without reconnecting, moving terminal focus or changing copy mode.
let pollTimer = null, polling = false;
async function pollSessions() {
  if (document.hidden || loading || polling || creating) return;
  polling = true;
  const previousSessions = sessions;
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store', redirect: 'manual' });
    if (!response.ok || response.redirected || response.type === 'opaqueredirect') throw Error('Status unavailable');
    const data = await response.json();
    if (sessions !== previousSessions || creating) return;
    const reported = new Set(data.sessions);
    const retained = [];
    for (const name of sessions) {
      if (reported.has(name)) { missingPolls.delete(name); continue; }
      const misses = (missingPolls.get(name) || 0) + 1;
      if (misses < 2) { missingPolls.set(name, misses); retained.push(name); }
      else missingPolls.delete(name);
    }
    const details = data.details || {};
    for (const name of retained) details[name] = sessionDetails[name] || { command: '' };
    sessions = [...data.sessions, ...retained]; sessionDetails = details; token = data.token; metadataStale = false;
    for (const name of frames.keys()) {
      if (!sessions.includes(name)) {
        frames.get(name).remove(); frames.delete(name); connections.delete(name); scrollModes.delete(name);
      }
    }
    if (active && !sessions.includes(active)) {
      active = null;
      const next = sessions.find(name => !hidden.has(name));
      if (next) activate(next, true);
      else { detailView.textContent = 'Unknown'; showStatus('No visible terminals', null, 'Unknown'); renderTabs(); }
    } else renderTabs();
  } catch {
    // Metadata availability is separate from the live iframe connection.
    if (sessions === previousSessions && !creating) { metadataStale = true; renderTabs(); }
  }
  finally { polling = false; }
}
function schedulePoll() {
  window.clearInterval(pollTimer);
  pollTimer = document.hidden ? null : window.setInterval(pollSessions, 5000);
}
document.addEventListener('visibilitychange', () => {
  schedulePoll();
  if (!document.hidden) void pollSessions();
});
newSession.addEventListener('click', () => newTab.click());
reconnect.addEventListener('click', () => {
  if (!active || retryMode === 'load') { void load(); return; }
  retryMode = 'frame'; retry.click();
});
retry.addEventListener('click', () => {
  status.focus();
  if (retryMode === 'load') { void load(); return; }
  const name = active;
  if (retryMode !== 'frame' || !name || !frames.has(name)) return;
  frames.get(name).remove();
  frames.delete(name);
  copyGestureAt = 0; pendingCopy = null; copySelection.hidden = true;
  connections.set(name, 'Reconnecting');
  activate(name);
});
newTab.addEventListener('click', async () => {
  if (!sessionReady || creating) return;
  creating = true; updateControls();
  const drawerOpen = sidebar.isDrawerOpen();
  try {
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token }, body: '{}' });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      if (response.status === 503 && failure.code === 'START_DIRECTORY_UNAVAILABLE') {
        showStatus('New session folder is unavailable — contact the administrator');
        return;
      }
      throw Error('Unable to create terminal');
    }
    const data = await response.json(); sessions = [...sessions, data.name]; activate(data.name, drawerOpen); sidebar.closeDrawer();
  } catch { sessionReady = false; showStatus('Unable to create terminal — check connection or sign in', 'load', connections.get(active) || 'Unknown'); } finally { creating = false; updateControls(); }
});
restore.addEventListener('click', event => {
  sidebar.closeMenu();
  hidden.clear(); saveHidden(); renderTabs();
  if (!active && sessions.length) activate(sessions[0], event.detail === 0);
});
async function splitSession(direction) {
  const target = splitTarget();
  if (!sessionReady || splitting || !target) return;
  const name = active, iframe = frames.get(name);
  const sessionId = target.sessionId, serverPid = target.serverPid;
  splitting = true; updateControls(); sidebar.closeMenu();
  const unavailable = () => { if (active === name) showStatus('Split unavailable: session changed or pane limit reached'); };
  try {
    const response = await fetch(`/api/sessions/${name}/identity`, { cache: 'no-store', redirect: 'manual' });
    if (!response.ok) { unavailable(); return; }
    const identity = await response.json();
    // Never split a replacement session or send a delayed action to another view.
    if (identity.sessionId !== sessionId || identity.serverPid !== serverPid) { unavailable(); return; }
    if (active !== name || frames.get(name) !== iframe || splitTarget()?.sessionId !== sessionId || splitTarget()?.serverPid !== serverPid) return;
    const result = await fetch(`/api/sessions/${name}/split/${direction}`, { method: 'POST', redirect: 'manual', headers: {
      'Content-Type': 'application/json', 'X-Terminal-Request': token,
      'X-Terminal-Session-Id': identity.sessionId, 'X-Terminal-Server-Pid': identity.serverPid,
    } });
    if (result.status === 409) { unavailable(); return; }
    if (!result.ok) throw Error('Split unavailable');
    if (active === name && frames.get(name) === iframe && connections.get(name) === 'Connected') {
      showConnection(name);
      iframe.contentWindow?.term?.focus();
    }
  } catch {
    if (active === name) showStatus('Split unavailable: check connection or sign in');
  } finally { splitting = false; updateControls(); }
}
splitRight.addEventListener('click', () => splitSession('horizontal'));
splitDown.addEventListener('click', () => splitSession('vertical'));
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
        terminalViewport.install(iframe);
        const state = event.data.state === 'Connecting' && connections.get(name) === 'Reconnecting' ? 'Reconnecting' : event.data.state;
        connections.set(name, state);
        if (event.data.state !== 'Connected') scrollModes.delete(name);
        if (event.data.state === 'Connected') iframe.contentWindow?.term?.textarea?.setAttribute('aria-label', 'Terminal input. Press Control Alt Shift T to focus toolbar.');
        sidebar.applyTheme();
        renderTabs();
        if (name === active && event.data.state !== 'Connected') mobileKeys.reset();
        if (name === active && event.data.state === 'Connected') displayControls.apply();
        if (name === active) showConnection(name);
      } else if (event.data?.type === 'terminal-scroll' && (event.data.mode === null || (typeof event.data.mode === 'string' && /^[a-z0-9-]{0,64}$/.test(event.data.mode)))) {
        scrollModes.set(name, event.data.mode);
        if (name === active) mobileKeys.resetIfTargetChanged();
        if (name === active) updateControls();
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
window.addEventListener('pageshow', () => { for (const iframe of frames.values()) terminalViewport.install(iframe); });
load();
schedulePoll();
