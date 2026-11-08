'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { installSidebarFixture, rows } = require('./sidebar-fixture');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ rejectStorage = false, narrow = false } = {}) {
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
    getClientRects() { return this.hidden ? [] : [{}]; }
    querySelector(selector) {
      const [, session, action] = /^\[data-session="([^"]+)"\]\[data-action="([^"]+)"\]$/.exec(selector) || [];
      return this.children.flatMap(child => child.children).find(child => child.dataset.session === session && child.dataset.action === action);
    }
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
  const store = {}, calls = [], timers = new Map(), documentListeners = {}, windowListeners = {};
  let sessionList = ['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb'], timerId = 0;
  let pollStatus = 200, command = 'bash', drawerOpen = narrow, splitStatus = 200;
  let createStatus = 201, createCode = null;
  let identity = { sessionId: '$1', serverPid: '123' }, identityWait = null;
  const localStorage = { getItem: key => store[key] ?? null, setItem: (key, value) => { if (rejectStorage) throw Error('Storage denied'); store[key] = value; } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url === '/api/sessions' && options.method === 'POST') {
      const name = 'web-cccccccccccc';
      if (createStatus === 201) sessionList.push(name);
      return { ok: createStatus === 201, status: createStatus, json: async () => createStatus === 201 ? { name } : { code: createCode } };
    }
    if (url === '/api/sessions' && !options.method && pollStatus !== 200) return { ok: false, status: pollStatus };
    if (url.endsWith('/identity')) {
      if (identityWait) await identityWait;
      return { ok: true, json: async () => identity };
    }
    if (url.includes('/split/')) return { ok: splitStatus === 200, status: splitStatus };
    return { ok: true, json: async () => ({
      sessions: [...sessionList], details: Object.fromEntries(sessionList.map(name => [name, { command }])), token: 'fixture-token',
    }) };
  };
  const context = vm.createContext({ document, window: { addEventListener: (name, handler) => { windowListeners[name] = handler; }, createMobileKeys: () => ({ toggle: new Element(), panel: new Element(), reset() {}, resetIfTargetChanged() {} }), createTerminalDisplayControls: () => ({ element: new Element(), apply() {} }) }, location: { origin: 'http://fixture.test' }, localStorage, fetch, console });
  installSidebarFixture(context.window, document, nodes, Element);
  let sidebarOptions;
  const createSidebar = context.window.TerminalSidebar.create;
  context.window.TerminalSidebar.create = options => {
    sidebarOptions = options;
    return {
      ...createSidebar(options),
      isDrawerOpen: () => drawerOpen,
      isNarrow: () => narrow,
      closeDrawer: () => { drawerOpen = false; },
    };
  };
  for (const id of ['sidebar-close', 'sidebar-toggle']) nodes[id] = new Element();
  document.addEventListener = (type, listener) => { documentListeners[type] = listener; };
  context.window.setInterval = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  context.window.clearInterval = id => timers.delete(id);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return {
    nodes, document, store, calls, timers,
    setSessions: list => { sessionList = list; },
    setPollStatus: value => { pollStatus = value; },
    setCommand: value => { command = value; },
    setIdentity: value => { identity = value; },
    setSplitStatus: value => { splitStatus = value; },
    setCreateResponse: (status, code = null) => { createStatus = status; createCode = code; },
    delayIdentity: () => { let resolve; identityWait = new Promise(done => { resolve = done; }); return resolve; },
    message: (frame, data) => windowListeners.message({ origin: 'http://fixture.test', source: frame.contentWindow, data }),
    connect: frame => windowListeners.message({ origin: 'http://fixture.test', source: frame.contentWindow, data: { type: 'terminal-connection', state: 'Connected' } }),
    drawerOpen: () => drawerOpen,
    search: value => { nodes['session-search'].value = value; sidebarOptions.onSearch(); },
    visibility: hidden => { document.hidden = hidden; documentListeners.visibilitychange(); },
    tick: async () => { for (const timer of [...timers.values()]) await timer.callback(); },
  };
}

test('New Session folder errors preserve existing controls and allow retry after repair', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.connect(frame);
  f.setCreateResponse(503, 'START_DIRECTORY_UNAVAILABLE');
  f.nodes['new-session'].click(); await flush();
  assert.equal(f.nodes.status.textContent, 'New session folder is unavailable — contact the administrator');
  assert.equal(f.nodes['rename-tab'].disabled, false, 'a folder error must not mark the live session list disconnected');
  assert.equal(f.nodes['new-session'].disabled, false, 'creation can be retried after configuration is repaired');
  assert.equal(f.nodes.views.children[0], frame, 'the existing live terminal is preserved');
  assert.equal(f.nodes.views.children.length, 1, 'the failed request does not activate a nonexistent terminal');
  f.setCreateResponse(201);
  f.nodes['new-session'].click(); await flush();
  assert.equal(f.nodes.views.children.length, 2, 'retry creates a terminal without a page reload');
});

test('New Session retains connection handling for authentication and unrelated service failures', async () => {
  for (const status of [401, 503]) {
    const f = fixture(); await flush();
    f.setCreateResponse(status, 'UNRELATED_ERROR');
    f.nodes['new-session'].click(); await flush();
    assert.match(f.nodes.status.textContent, /check connection or sign in/);
    assert.equal(f.nodes['rename-tab'].disabled, true);
    assert.equal(f.nodes['new-session'].disabled, true);
  }
});

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

test('a session disappears only after two consecutive successful misses', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.setSessions(['web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb']);
  await f.tick();
  assert.equal(f.nodes.views.children[0], frame, 'one miss keeps the existing attachment');
  assert.equal(rows(f.nodes).find(row => row.children[0].dataset.session === 'shared').children[3].textContent, 'Disconnected');
  f.setSessions(['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb']);
  await f.tick();
  f.setSessions(['web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb']);
  await f.tick();
  assert.equal(f.nodes.views.children[0], frame, 'a successful reappearance resets the miss count');
  await f.tick();
  assert.equal(f.nodes.views.children.includes(frame), false);
  assert.equal(f.nodes.views.children[0].src, '/terminal/web-aaaaaaaaaaaa');
  assert.equal(rows(f.nodes).some(row => row.children[0].dataset.session === 'shared'), false);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('503 metadata polls keep live frames and report stale sidebar status until recovery', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  rows(f.nodes)[1].children[0].click();
  const second = f.nodes.views.children[1];
  f.setPollStatus(503);
  await f.tick(); await f.tick();
  assert.deepEqual(f.nodes.views.children, [frame, second]);
  assert.equal(rows(f.nodes).length, 3);
  for (const row of rows(f.nodes)) assert.equal(row.children[3].textContent, 'Status unavailable');
  assert.equal(f.nodes['current-secondary'].textContent, 'Status unavailable');
  f.setPollStatus(200);
  await f.tick();
  assert.deepEqual(f.nodes.views.children, [frame, second]);
  assert.equal(rows(f.nodes)[0].children[3].textContent, 'Disconnected');
  assert.notEqual(f.nodes['current-secondary'].textContent, 'Status unavailable');
});

test('a transient empty list retains every frame and failed polls do not count as misses', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  f.setSessions([]);
  f.setPollStatus(503);
  await f.tick();
  f.setPollStatus(200);
  await f.tick();
  assert.equal(f.nodes.views.children[0], frame);
  assert.equal(rows(f.nodes).length, 3);
  f.setSessions(['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb']);
  await f.tick();
  assert.equal(f.nodes.views.children[0], frame);
  assert.equal(rows(f.nodes).length, 3);
});

test('unchanged polling retains exact sidebar controls, while changed status and search render', async () => {
  const f = fixture(); await flush();
  const first = rows(f.nodes)[0].children[0];
  first.focus();
  await f.tick(); await f.tick();
  assert.equal(rows(f.nodes)[0].children[0], first);
  assert.equal(f.document.activeElement, first);
  f.setPollStatus(503); await f.tick();
  const stale = rows(f.nodes)[0].children[0];
  assert.notEqual(stale, first);
  assert.equal(f.document.activeElement, stale, 'a changed view restores the focused control');
  await f.tick();
  assert.equal(rows(f.nodes)[0].children[0], stale);
  f.search('aaaaaaaaaaaa');
  assert.equal(rows(f.nodes).length, 1);
  assert.equal(rows(f.nodes)[0].children[0].dataset.session, 'web-aaaaaaaaaaaa');
  assert.equal(f.nodes['search-results'].textContent, '1 session found');
  f.setPollStatus(200);
  f.search('');
  f.connect(f.nodes.views.children[0]);
  await f.tick();
  assert.equal(rows(f.nodes)[0].children[3].textContent, 'Idle');
  const idle = rows(f.nodes)[0].children[0];
  f.setCommand('vim');
  await f.tick();
  assert.notEqual(rows(f.nodes)[0].children[0], idle);
  assert.equal(rows(f.nodes)[0].children[3].textContent, 'Running · vim');
});

test('narrow list navigation keeps the drawer open until explicit selection', async () => {
  const f = fixture({ narrow: true }); await flush();
  for (const key of ['ArrowDown', 'ArrowUp', 'End', 'Home']) {
    const active = rows(f.nodes).find(row => row.children[0].attributes['aria-pressed'] === 'true').children[0];
    let prevented = false;
    active.listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.drawerOpen(), true, key);
    assert.equal(f.document.activeElement.attributes['aria-pressed'], 'true');
  }
  // Selecting the already active row also exercises focus without a DOM rebuild.
  f.document.activeElement.click();
  assert.equal(f.drawerOpen(), false);
});

test('dialog cancellation returns to a visible drawer control when its opener becomes hidden', async () => {
  const f = fixture(); await flush();
  const close = rows(f.nodes)[0].children.find(child => child.dataset.action === 'close');
  close.click(); await flush();
  close.hidden = true;
  f.nodes['close-dialog'].oncancel({ preventDefault() {} });
  assert.equal(f.nodes['close-dialog'].open, false);
  assert.equal(f.document.activeElement, f.nodes['sidebar-close']);
  close.hidden = false; close.click(); await flush();
  close.hidden = true;
  f.nodes['sidebar-close'].hidden = true;
  f.nodes['close-cancel'].click();
  assert.equal(f.document.activeElement, f.nodes['sidebar-toggle']);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('splits require a connected active session with valid identity metadata', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  const buttons = [f.nodes['split-right'], f.nodes['split-down']];
  const disabled = expected => {
    for (const button of buttons) {
      assert.equal(button.disabled, expected);
      if (expected) assert.match(button.title, /known session identity/);
    }
  };
  disabled(true);
  f.connect(frame);
  disabled(true);
  for (const target of [
    { session: 'shared', sessionId: 'bad', serverPid: '123' },
    { session: 'shared', sessionId: '$1', serverPid: 'bad' },
    { session: 'web-aaaaaaaaaaaa', sessionId: '$1', serverPid: '123' },
    { session: 'shared', sessionId: '$1', serverPid: '123' },
  ]) {
    frame.contentWindow.webTerminalTarget = target;
    f.message(frame, { type: 'terminal-scroll', mode: '' });
    disabled(target.session !== 'shared' || target.sessionId !== '$1' || target.serverPid !== '123');
  }
  f.message(frame, { type: 'terminal-connection', state: 'Disconnected' });
  disabled(true);
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
});

test('split conflicts are announced without replacing the frame; successful splits refocus it', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  let focused = 0;
  frame.contentWindow.term = { focus() { focused++; } };
  frame.contentWindow.webTerminalTarget = { session: 'shared', sessionId: '$1', serverPid: '123' };
  f.connect(frame);
  f.setSplitStatus(409);
  f.nodes['split-right'].click(); await flush();
  assert.equal(f.nodes.status.textContent, 'Split unavailable: session changed or pane limit reached');
  assert.equal(focused, 0);
  assert.equal(f.nodes.views.children[0], frame);
  assert.equal(f.nodes['split-right'].disabled, false);
  f.setSplitStatus(200);
  f.nodes['split-down'].click();
  f.nodes['split-right'].click(); // Both controls remain disabled while the action is pending.
  await flush();
  assert.equal(focused, 1);
  assert.equal(f.nodes.views.children[0], frame);
  assert.equal(f.nodes.views.children.length, 1);
  assert.equal(f.nodes.status.textContent, 'Connected');
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.url), [
    '/api/sessions/shared/split/horizontal', '/api/sessions/shared/split/vertical',
  ]);
});

test('split identity refresh rejects a replacement session and a delayed action after switching views', async () => {
  const f = fixture(); await flush();
  const frame = f.nodes.views.children[0];
  frame.contentWindow.webTerminalTarget = { session: 'shared', sessionId: '$1', serverPid: '123' };
  f.connect(frame);
  f.setIdentity({ sessionId: '$2', serverPid: '123' });
  f.nodes['split-right'].click(); await flush();
  assert.equal(f.nodes.status.textContent, 'Split unavailable: session changed or pane limit reached');
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  f.setIdentity({ sessionId: '$1', serverPid: '123' });
  const release = f.delayIdentity();
  f.nodes['split-down'].click();
  rows(f.nodes)[1].children[0].click();
  release(); await flush();
  assert.equal(f.calls.some(call => call.method === 'POST'), false);
  assert.equal(f.nodes['split-down'].disabled, true, 'the new view has no connected identity');
});
