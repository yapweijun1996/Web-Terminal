'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { installSidebarFixture, rows } = require('./sidebar-fixture');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ rejectStorage = false } = {}) {
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = '';
      this.classList = { toggle() {} }; this.dataset = {};
      if (tag === 'iframe') this.contentWindow = { listeners: {}, focus() {}, addEventListener(name, handler) { this.listeners[name] = handler; } };
    }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
    replaceChildren() { this.children = []; }
    before() {}
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    select() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    click() { if (!this.hidden && !this.disabled) { this.listeners.click?.({ detail: 0 }); this.onclick?.({ detail: 0 }); } }
  }
  const ids = ['tabs', 'views', 'status', 'detail-view', 'detail-link', 'scroll-status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection', 'close-dialog', 'close-name', 'close-error', 'close-confirm', 'close-cancel', 'close-dismiss', 'close-hide'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes['rename-form'].hidden = true;
  const header = new Element();
  document = { activeElement: null, querySelector: selector => selector === 'header' ? header : nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  const store = {}, calls = [], timers = new Map(), documentListeners = {};
  let sessionList = ['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb'], timerId = 0;
  const localStorage = { getItem: key => store[key] ?? null, setItem: (key, value) => { if (rejectStorage) throw Error('Storage denied'); store[key] = value; } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return { ok: true, json: async () => url.endsWith('/identity') ? ({ sessionId: '$1', serverPid: '123' }) : ({ sessions: [...sessionList], token: 'fixture-token' }) };
  };
  const context = vm.createContext({ document, window: { addEventListener() {}, createMobileKeys: () => ({ toggle: new Element(), panel: new Element(), reset() {}, resetIfTargetChanged() {} }), createTerminalDisplayControls: () => ({ element: new Element(), apply() {} }) }, location: { origin: 'http://fixture.test' }, localStorage, fetch, console });
  installSidebarFixture(context.window, document, nodes, Element);
  document.addEventListener = (type, listener) => { documentListeners[type] = listener; };
  context.window.setInterval = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  context.window.clearInterval = id => timers.delete(id);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return {
    nodes, document, store, calls, timers,
    setSessions: list => { sessionList = list; },
    visibility: hidden => { document.hidden = hidden; documentListeners.visibilitychange(); },
    tick: async () => { for (const timer of [...timers.values()]) await timer.callback(); },
  };
}

test('keyboard navigation keeps focus and hiding another view preserves the active view', async () => {
  const f = fixture(); await flush();
  const tabs = { get children() { return rows(f.nodes); } };
  const first = tabs.children[0].children[0]; first.focus();
  let prevented = false;
  first.listeners.keydown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement.textContent, 'Terminal aaaaaaaaaaaa');
  assert.equal(f.document.activeElement.attributes['aria-pressed'], 'true');
  tabs.children[0].children.find(child => child.dataset.action === 'close').click();
  assert.equal(f.nodes['close-dialog'].open, true);
  f.nodes['close-hide'].click();
  assert.equal(f.document.activeElement.textContent, 'Terminal aaaaaaaaaaaa', 'hiding a different view does not switch the active view');
  assert.equal(f.calls.some(call => call.method === 'POST'), false, 'hiding a view must not terminate a session');
});

test('closing requires explicit confirmation; cancel leaves the session untouched', async () => {
  const f = fixture(); await flush();
  rows(f.nodes)[1].children.find(child => child.dataset.action === 'close').click(); await flush();
  assert.equal(f.nodes['close-name'].textContent, 'Terminal aaaaaaaaaaaa (web-aaaaaaaaaaaa)');
  f.nodes['close-dismiss'].click();
  assert.equal(f.nodes['close-dialog'].open, false);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  rows(f.nodes)[1].children.find(child => child.dataset.action === 'close').click(); await flush();
  f.nodes['close-confirm'].click(); await flush();
  assert.ok(f.calls.some(call => call.url === '/api/sessions/web-aaaaaaaaaaaa/close' && call.method === 'POST'));
  assert.equal(rows(f.nodes).length, 2);
  assert.equal(rows(f.nodes)[0].children[0].textContent, 'Existing terminal');
});

test('keyboard shortcut returns from the active terminal to the toolbar', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  frame.listeners.load();
  let prevented = false, stopped = false;
  frame.contentWindow.listeners.keydown({ code: 'KeyT', altKey: true, shiftKey: true, ctrlKey: true, metaKey: false,
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(f.document.activeElement, f.nodes['rename-tab']);
  assert.equal(f.nodes['rename-tab'].attributes['aria-keyshortcuts'], 'Control+Alt+Shift+T');
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('renaming is browser-local, unique, and preserves an identifiable view', async () => {
  const f = fixture(); await flush();
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Build logs';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.equal(rows(f.nodes)[0].children[0].textContent, 'Build logs');
  assert.equal(f.nodes['detail-view'].textContent, '1 of 3', 'status details do not repeat user-provided names');
  assert.equal(f.nodes.views.children[0].title, 'Build logs');
  assert.match(f.store['linux-web-terminal-names-v1'], /Build logs/);
  assert.equal(f.document.activeElement, f.nodes['rename-tab']);
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Terminal aaaaaaaaaaaa';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.match(f.nodes['rename-error'].textContent, /different/);
  assert.equal(rows(f.nodes)[0].children[0].textContent, 'Build logs');
  assert.equal(f.calls.some(call => call.method === 'POST'), false, 'renaming does not mutate a tmux session');
});

test('a storage failure is reported without pretending the rename was saved', async () => {
  const f = fixture({ rejectStorage: true }); await flush();
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Temporary name';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.match(f.nodes['rename-error'].textContent, /Unable to save/);
  assert.equal(rows(f.nodes)[0].children[0].textContent, 'Existing terminal');
});

test('metadata polling pauses while hidden and preserves the active frame and sidebar focus', async () => {
  const f = fixture(); await flush();
  assert.equal([...f.timers.values()][0].delay, 5000);
  const frame = f.nodes.views.children[0];
  rows(f.nodes)[1].children.find(child => child.dataset.action === 'pin').focus();
  await f.tick();
  assert.equal(f.nodes.views.children[0], frame, 'metadata refresh must not reconnect a terminal');
  assert.equal(f.document.activeElement.dataset.session, 'web-aaaaaaaaaaaa');
  assert.equal(f.document.activeElement.dataset.action, 'pin');
  const before = f.calls.length;
  f.visibility(true);
  assert.equal(f.timers.size, 0);
  await f.tick();
  assert.equal(f.calls.length, before, 'a hidden page sends no periodic list requests');
  f.visibility(false); await flush();
  assert.equal(f.timers.size, 1);
  assert.equal(f.calls.length, before + 1);
  assert.equal(f.nodes.views.children[0], frame);
});

test('a removed active session cannot retain a stale terminal frame after polling', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.setSessions(['web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb']);
  await f.tick();
  assert.equal(f.nodes.views.children.includes(frame), false);
  assert.equal(f.nodes.views.children[0].src, '/terminal/web-aaaaaaaaaaaa');
  assert.equal(rows(f.nodes).some(row => row.children[0].dataset.session === 'shared'), false);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});
