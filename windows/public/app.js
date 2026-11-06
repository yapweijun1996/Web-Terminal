/* global Terminal, FitAddon */
'use strict';
const views = new Map();
const tabs = document.getElementById('tabs');
const workspace = document.getElementById('workspace');
const connection = document.getElementById('connection');
let activeId = null;
let sessions = [];
let token;
let updating = false;
let serial = 0;
let hidden = new Set();
try { hidden = new Set(JSON.parse(localStorage.getItem('windows-terminal-hidden') || '[]')); } catch { /* Optional view preferences. */ }
const saveHidden = () => { try { localStorage.setItem('windows-terminal-hidden', JSON.stringify([...hidden])); } catch { /* Storage can be disabled. */ } };
function status(view, text) {
  view.state = text;
  if (activeId === view.id) connection.textContent = text;
}
async function api(route, method = 'GET') {
  const response = await fetch(route, { method, credentials: 'same-origin', headers: method === 'POST' ? { 'X-Terminal-Request': token } : {} });
  if (!response.ok) throw new Error(response.status === 403 ? 'Sign in again: reload this page' : 'Terminal request failed');
  return response.json();
}
function connect(view) {
  clearTimeout(view.timer);
  const generation = ++view.generation;
  if (view.socket) view.socket.close();
  status(view, 'Connecting');
  view.ready = false;
  const socket = new WebSocket(`wss://${location.host}/ws/${view.id}`, ['terminal', token]);
  view.socket = socket;
  socket.onmessage = event => {
    if (generation !== view.generation || !views.has(view.id)) return;
    let value;
    try { value = JSON.parse(event.data); } catch { socket.close(); return; }
    if (value.type === 'snapshot') {
      view.term.reset();
      view.term.resize(value.cols, value.rows);
      view.term.write(value.data, () => {
        if (generation !== view.generation || socket.readyState !== WebSocket.OPEN) return;
        view.ready = true;
        view.attempts = 0;
        status(view, 'Connected');
        if (view.id === activeId) fit(view);
      });
    } else if (value.type === 'output') view.term.write(value.data);
  };
  socket.onclose = event => {
    if (generation !== view.generation || !views.has(view.id)) return;
    view.ready = false;
    if (event.code === 4001) return status(view, 'Session expired — reload to sign in');
    if (event.code === 4004) { status(view, 'Shell exited'); refresh().catch(showError); return; }
    status(view, 'Disconnected — shell may still be running');
    if (!hidden.has(view.id) && view.attempts++ < 5) view.timer = setTimeout(() => connect(view), Math.min(1000 * 2 ** view.attempts, 15000));
  };
  socket.onerror = () => status(view, 'Connection unavailable');
}
function fit(view) {
  if (hidden.has(view.id) || view.id !== activeId) return;
  view.fit.fit();
  if (view.ready && view.socket.readyState === WebSocket.OPEN) view.socket.send(JSON.stringify({ type: 'resize', cols: view.term.cols, rows: view.term.rows }));
}
function createView(session) {
  const node = document.createElement('div');
  node.className = 'terminal-view'; node.hidden = true; workspace.append(node);
  const term = new Terminal({ cursorBlink: true, fontSize: 15, scrollback: 5000, allowProposedApi: false,
    theme: { background: '#101216', foreground: '#e6e8ec' } });
  const fitAddon = new FitAddon.FitAddon(); term.loadAddon(fitAddon); term.open(node);
  const view = { id: session.id, label: `PowerShell ${++serial}`, node, term, fit: fitAddon, socket: null, generation: 0, attempts: 0, ready: false, state: 'Disconnected' };
  views.set(session.id, view);
  term.onData(data => {
    // Never queue, resend or submit user input during reconnect or screen replay.
    if (view.ready && activeId === view.id && view.socket.readyState === WebSocket.OPEN) view.socket.send(JSON.stringify({ type: 'input', data }));
  });
  return view;
}
function activate(id) {
  if (!views.has(id)) return;
  hidden.delete(id); saveHidden(); activeId = id;
  for (const view of views.values()) view.node.hidden = view.id !== id;
  const view = views.get(id);
  if (!view.socket || view.socket.readyState > WebSocket.OPEN) connect(view);
  render(); connection.textContent = view.state;
  requestAnimationFrame(() => { fit(view); view.term.focus(); });
}
function hide(id) {
  hidden.add(id); saveHidden();
  const view = views.get(id); clearTimeout(view.timer);
  ++view.generation; view.ready = false; view.socket?.close(); view.node.hidden = true;
  if (activeId === id) {
    activeId = null;
    const next = [...views.keys()].find(key => !hidden.has(key));
    if (next) activate(next); else connection.textContent = 'No active view';
  }
  render();
}
function render() {
  tabs.replaceChildren();
  for (const [id, view] of views) {
    if (hidden.has(id)) continue;
    const tab = document.createElement('div'); tab.className = `tab${id === activeId ? ' active' : ''}`;
    const select = document.createElement('button'); select.textContent = view.label;
    select.setAttribute('aria-pressed', String(id === activeId)); select.onclick = () => activate(id);
    const close = document.createElement('button'); close.textContent = '×'; close.className = 'hide';
    close.setAttribute('aria-label', `Hide ${view.label}; keep shell running`); close.onclick = () => hide(id);
    tab.append(select, close); tabs.append(tab);
  }
  document.getElementById('empty').hidden = Boolean(activeId);
  document.getElementById('end').disabled = !activeId;
  document.getElementById('retry').disabled = !activeId;
}
async function refresh() {
  const data = await api('/api/sessions'); token = data.token; sessions = data.sessions;
  const ids = new Set(sessions.map(session => session.id));
  for (const [id, view] of views) if (!ids.has(id)) {
    ++view.generation; clearTimeout(view.timer); view.socket?.close(); view.term.dispose(); view.node.remove(); views.delete(id);
    if (activeId === id) activeId = null;
  }
  for (const session of sessions) if (!views.has(session.id)) createView(session);
  if (!activeId) {
    const first = sessions.find(session => !hidden.has(session.id));
    if (first) activate(first.id);
  }
  render();
}
function showError(error) { connection.textContent = error.message; }
document.getElementById('new').onclick = async () => {
  if (updating) return;
  updating = true;
  try { const created = await api('/api/sessions', 'POST'); await refresh(); activate(created.id); }
  catch (error) { showError(error); } finally { updating = false; }
};
document.getElementById('retry').onclick = () => { const view = views.get(activeId); if (view) { view.attempts = 0; connect(view); } };
document.getElementById('end').onclick = async () => {
  const id = activeId; const view = views.get(id);
  if (!view || !confirm(`End ${view.label}? This terminates its PowerShell and running work. Hide the view to keep work running.`)) return;
  try { await api(`/api/sessions/${id}/end`, 'POST'); await refresh(); } catch (error) { showError(error); }
};
document.getElementById('all').onclick = async () => {
  try {
    await refresh();
    const list = document.getElementById('session-list'); list.replaceChildren();
    for (const [id, view] of views) {
      const button = document.createElement('button'); button.textContent = `${view.label}${hidden.has(id) ? ' · hidden' : ''}`;
      button.onclick = () => { activate(id); document.getElementById('chooser').close(); }; list.append(button);
    }
    if (!views.size) list.textContent = 'No running shells. Create a new terminal.';
    document.getElementById('chooser').showModal();
  } catch (error) { showError(error); }
};
document.getElementById('dismiss').onclick = () => document.getElementById('chooser').close();
new ResizeObserver(() => { const view = views.get(activeId); if (view) fit(view); }).observe(workspace);
window.addEventListener('online', () => { const view = views.get(activeId); if (view && !view.ready) { view.attempts = 0; connect(view); } });
refresh().catch(showError);
