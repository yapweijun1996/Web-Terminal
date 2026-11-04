'use strict';
const tabs = document.querySelector('#tabs');
const views = document.querySelector('#views');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const restore = document.querySelector('#restore');
const newTab = document.querySelector('#new-tab');
const latest = document.querySelector('#latest');
const storageKey = 'linux-web-terminal-hidden-v1';
let hidden;
try { hidden = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch { hidden = new Set(); }
let sessions = [], active = null, token = '';
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
  active = name;
  if (!frames.has(name)) {
    const iframe = document.createElement('iframe');
    iframe.src = `/terminal/${name}`; iframe.title = label(name); views.append(iframe); frames.set(name, iframe);
  }
  for (const [id, iframe] of frames) iframe.classList.toggle('active', id === name);
  showConnection(name);
  renderTabs();
  updateControls();
}
function renderTabs() {
  tabs.replaceChildren();
  for (const name of sessions.filter(n => !hidden.has(n))) {
    const group = document.createElement('div'); group.className = `tab${name === active ? ' active' : ''}`;
    const open = document.createElement('button'); open.type = 'button'; open.textContent = label(name);
    open.setAttribute('aria-pressed', String(name === active)); open.addEventListener('click', () => activate(name));
    const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'hide'; hide.textContent = '×';
    hide.setAttribute('aria-label', `Hide ${label(name)}`); hide.title = 'Hide tab; keep session running';
    hide.addEventListener('click', () => {
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
  if (event.origin !== location.origin || event.data?.type !== 'terminal-connection' || !['Connecting', 'Connected', 'Disconnected', 'Connection error'].includes(event.data.state)) return;
  for (const [name, iframe] of frames) {
    if (event.source === iframe.contentWindow) {
      connections.set(name, event.data.state);
      if (name === active) showConnection(name);
      break;
    }
  }
});
load();
