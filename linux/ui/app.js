'use strict';
const tabs = document.querySelector('#tabs');
const views = document.querySelector('#views');
const status = document.querySelector('#status');
const restore = document.querySelector('#restore');
const newTab = document.querySelector('#new-tab');
const latest = document.querySelector('#latest');
const storageKey = 'linux-web-terminal-hidden-v1';
let hidden;
try { hidden = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]')); } catch { hidden = new Set(); }
let sessions = [], active = null, token = '';
const frames = new Map();
const connections = new Map();
function label(name) { return name === 'shared' ? 'Existing terminal' : `Terminal ${name.slice(-4)}`; }
function saveHidden() { try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); } catch {} }
function activate(name) {
  active = name;
  if (!frames.has(name)) {
    const iframe = document.createElement('iframe');
    iframe.src = `/terminal/${name}`; iframe.title = label(name); views.append(iframe); frames.set(name, iframe);
  }
  for (const [id, iframe] of frames) iframe.classList.toggle('active', id === name);
  status.textContent = connections.get(name) || 'Connecting';
  renderTabs();
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
      const next = sessions.find(n => !hidden.has(n)); if (next) activate(next); else { active = null; renderTabs(); }
    });
    group.append(open, hide); tabs.append(group);
  }
  restore.hidden = !sessions.some(n => hidden.has(n));
}
async function load() {
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    if (!response.ok) throw Error('Unable to load terminals');
    const data = await response.json(); sessions = data.sessions; token = data.token;
    const first = sessions.find(n => !hidden.has(n));
    if (first) activate(first); else renderTabs();
    if (!first) status.textContent = 'No visible terminals';
  } catch { status.textContent = 'Unable to connect'; }
}
newTab.addEventListener('click', async () => {
  newTab.disabled = true;
  try {
    const response = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token }, body: '{}' });
    if (!response.ok) throw Error('Unable to create terminal');
    const data = await response.json(); sessions.push(data.name); activate(data.name);
  } catch { status.textContent = 'Unable to create terminal'; } finally { newTab.disabled = false; }
});
restore.addEventListener('click', () => { hidden.clear(); saveHidden(); renderTabs(); if (!active && sessions.length) activate(sessions[0]); });
latest.addEventListener('click', async () => {
  if (!active) return;
  try {
    const response = await fetch(`/api/sessions/${active}/latest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Request': token }, body: '{}' });
    if (!response.ok) throw Error('Unable to return to latest output');
    frames.get(active)?.contentWindow?.focus();
  } catch { status.textContent = 'Unable to return to latest output'; }
});
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.data?.type !== 'terminal-connection') return;
  for (const [name, iframe] of frames) {
    if (event.source === iframe.contentWindow) {
      connections.set(name, event.data.state);
      if (name === active) status.textContent = event.data.state;
      break;
    }
  }
});
load();
