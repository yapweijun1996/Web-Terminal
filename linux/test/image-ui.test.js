'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = {}; this.disabled = false; this.hidden = false; this.textContent = '';
    this.classList = { toggle() {} }; this.dataset = {};
    if (tag === 'iframe') this.contentWindow = { webTerminalTarget: { session: 'shared', sessionId: '$0', pane: '%0', serverPid: '10' }, focus() {} };
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute() {}
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren() { this.children = []; }
  before() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  focus() {}
  scrollIntoView() {}
  select() {}
  click() { if (!this.disabled) return this.onclick?.() ?? this.listeners.click?.(); }
}

function fixture() {
  const ids = ['tabs', 'views', 'status', 'detail-view', 'detail-link', 'scroll-status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  const listeners = {}, calls = [];
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; }, createTerminalDisplayControls: () => ({ element: new Element(), apply() {} }) };
  const location = { origin: 'http://fixture.test' };
  const ticket = 'a'.repeat(48), savedPath = '/tmp/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
  let releaseUpload;
  const fetch = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    if (url === '/api/sessions') return { ok: true, json: async () => ({ sessions: ['shared'], token: 'fixture-token' }) };
    if (url === '/api/images/prepare') return { ok: true, json: async () => ({ ticket, target: { windowIndex: '0', paneIndex: '0' } }) };
    if (url === '/api/images') return new Promise(resolve => { releaseUpload = () => resolve({ ok: true, json: async () => ({ path: savedPath }) }); });
    if (url === '/api/images/result') return { ok: true, json: async () => ({ state: 'saved', path: savedPath, attempted: false }) };
    return { ok: true };
  };
  const context = vm.createContext({ document, window, location, fetch, localStorage: { getItem: () => null, setItem() {} }, navigator: { clipboard: { writeText: async () => {} } }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return { nodes, listeners, calls, context, location, ticket, release: () => releaseUpload() };
}

test('image upload binds the observed pane and waits for explicit insertion', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.listeners.message({ origin: f.location.origin, source: frame.contentWindow, data: { type: 'terminal-connection', state: 'Connected' } });
  f.context.fixtureFrame = frame;
  const operation = vm.runInContext("uploadImage({type:'image/png',size:8}, 'shared', fixtureFrame)", f.context);
  await flush();
  const prepare = f.calls.find(call => call.url === '/api/images/prepare');
  assert.equal(prepare.headers['X-Terminal-Pane'], '%0');
  frame.contentWindow.webTerminalTarget.pane = '%1';
  f.release(); await operation;
  const item = f.nodes['image-results'].children[0];
  assert.match(item.children[0].textContent, /window 0, pane 0/);
  assert.equal(f.calls.some(call => call.url === '/api/images/insert'), false, 'completion never silently pastes');
  await item.children.find(child => child.textContent === 'Insert into captured pane').click();
  assert.equal(f.calls.find(call => call.url === '/api/images/insert').headers['X-Image-Receipt'], f.ticket);
});

test('a disconnected view retains the saved path without sending an insert', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.listeners.message({ origin: f.location.origin, source: frame.contentWindow, data: { type: 'terminal-connection', state: 'Connected' } });
  f.context.fixtureFrame = frame;
  const operation = vm.runInContext("uploadImage({type:'image/png',size:8}, 'shared', fixtureFrame)", f.context);
  await flush(); f.release(); await operation;
  f.listeners.message({ origin: f.location.origin, source: frame.contentWindow, data: { type: 'terminal-connection', state: 'Disconnected' } });
  const item = f.nodes['image-results'].children[0];
  await item.children.find(child => child.textContent === 'Insert into captured pane').click();
  assert.ok(item.children.some(child => child.tag === 'input' && child.value.endsWith('.png')));
  assert.equal(f.calls.some(call => call.url === '/api/images/insert'), false);
});
