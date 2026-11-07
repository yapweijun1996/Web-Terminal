'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { installSidebarFixture, rows } = require('./sidebar-fixture');

const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {};
    this.hidden = false; this.disabled = false; this.textContent = '';
    this.classList = { toggle: (name, enabled) => { this[name] = enabled; } }; this.dataset = {};
    if (tag === 'iframe') this.contentWindow = { focus() {} };
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  append(...elements) { for (const element of elements) { element.parent = this; this.children.push(element); } }
  replaceChildren() { this.children = []; }
  before() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() {}
  scrollIntoView() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { if (!this.hidden && !this.disabled) { this.listeners.click?.(); this.onclick?.(); } }
}

test('session auth failure and iframe disconnect offer safe explicit recovery', async () => {
  const nodes = Object.fromEntries(['tabs', 'views', 'status', 'detail-view', 'detail-link', 'scroll-status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection', 'close-dialog', 'close-name', 'close-error', 'close-confirm', 'close-cancel', 'close-dismiss', 'close-hide'].map(id => [id, new Element()]));
  const header = new Element();
  const document = { querySelector: selector => selector === 'header' ? header : nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  const listeners = {};
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; }, createMobileKeys: () => ({ toggle: new Element(), panel: new Element(), reset() {}, resetIfTargetChanged() {} }), createTerminalDisplayControls: () => ({ element: new Element(), apply() {} }) };
  const location = { origin: 'http://fixture.test' };
  let mode = 'auth';
  let mutationRequests = 0;
  const fetch = async (_url, options = {}) => {
    if (options.method === 'POST') mutationRequests++;
    if (mode === 'auth') return { status: 403, type: 'basic', redirected: false, ok: false };
    return { status: 200, type: 'basic', redirected: false, ok: true, json: async () => ({ sessions: ['shared'], token: 'fixture-token' }) };
  };
  const localStorage = { getItem: () => null, setItem() {} };
  const source = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
  installSidebarFixture(window, document, nodes, Element);
  vm.runInNewContext(source, { document, window, location, localStorage, fetch, console });
  await flush();
  assert.equal(nodes.status.textContent, 'Sign-in may be required');
  assert.equal(nodes.retry.hidden, false);
  assert.equal(nodes['new-tab'].disabled, true);
  assert.equal(nodes.latest.disabled, true);

  mode = 'ok';
  nodes.retry.click();
  await flush();
  const first = nodes.views.children[0];
  assert.ok(first);
  assert.equal(nodes.status.textContent, 'Connecting');
  assert.equal(nodes['detail-view'].textContent, '1 of 1');
  assert.equal(nodes['detail-link'].textContent, 'Connecting');
  assert.equal(nodes['new-tab'].disabled, false);
  const message = (source, state, origin = location.origin) => listeners.message({ source, origin, data: { type: 'terminal-connection', state } });
  message(first.contentWindow, 'Connected');
  assert.equal(nodes.status.textContent, 'Connected');
  assert.equal(nodes['detail-link'].textContent, 'Connected');
  listeners.message({ source: first.contentWindow, origin: location.origin, data: { type: 'terminal-scroll', mode: '' } });
  assert.equal(nodes['scroll-status'].textContent, 'tmux live; app scroll unknown');
  listeners.message({ source: first.contentWindow, origin: location.origin, data: { type: 'terminal-scroll', mode: 'copy-mode' } });
  assert.equal(nodes['scroll-status'].textContent, 'tmux scrollback; app scroll unknown');
  message({}, 'Disconnected');
  message(first.contentWindow, 'Disconnected', 'http://other.test');
  assert.equal(nodes.status.textContent, 'Connected', 'unrelated windows and origins must not change state');

  message(first.contentWindow, 'Disconnected');
  assert.equal(nodes['scroll-status'].textContent, 'tmux scroll unknown; app scroll unknown');
  assert.equal(nodes['detail-link'].textContent, 'Disconnected — retry or sign in');
  assert.equal(nodes.retry.hidden, false);
  nodes.retry.click();
  const second = nodes.views.children[0];
  assert.notEqual(second, first, 'retry creates a new view for the same session');
  assert.equal(second.src, first.src);
  assert.equal(nodes.status.textContent, 'Connecting');
  message(first.contentWindow, 'Disconnected');
  assert.equal(nodes.status.textContent, 'Connecting', 'late messages from the removed view are ignored');
  message(second.contentWindow, 'Connected');
  assert.equal(nodes.status.textContent, 'Connected');
  assert.equal(nodes.retry.hidden, true);
  listeners.message({ source: second.contentWindow, origin: location.origin, data: { type: 'terminal-scroll', mode: '' } });
  rows(nodes)[0].children.find(child => child.dataset.action === 'close').click();
  nodes['close-hide'].click();
  assert.equal(nodes['detail-view'].textContent, 'Unknown');
  assert.equal(nodes['detail-link'].textContent, 'Unknown');
  nodes.restore.listeners.click({ detail: 0 });
  assert.equal(nodes.status.textContent, 'Connecting', 'a restored view starts with a fresh connection state');
  assert.equal(nodes['scroll-status'].textContent, 'tmux scroll unknown; app scroll unknown');
  assert.equal(mutationRequests, 0, 'retry must not create a session or submit a command');
});

test('terminal clipboard requests need the active view and support a manual retry', async () => {
  const nodes = Object.fromEntries(['tabs', 'views', 'status', 'detail-view', 'detail-link', 'scroll-status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection'].map(id => [id, new Element()]));
  const header = new Element();
  const document = { querySelector: selector => selector === 'header' ? header : nodes[selector.slice(1)], createElement: tag => new Element(tag), hasFocus: () => true };
  const listeners = {};
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; }, createMobileKeys: () => ({ toggle: new Element(), panel: new Element(), reset() {}, resetIfTargetChanged() {} }), createTerminalDisplayControls: () => ({ element: new Element(), apply() {} }) };
  const location = { origin: 'http://fixture.test' };
  const writes = [];
  let deny = true;
  const navigator = { clipboard: { writeText: async text => { if (deny) throw Error('denied'); writes.push(text); } } };
  const fetch = async () => ({ ok: true, json: async () => ({ sessions: ['shared', 'web-123456789abc'], token: 'fixture' }) });
  const localStorage = { getItem: () => null, setItem() {} };
  installSidebarFixture(window, document, nodes, Element);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), { document, window, location, localStorage, fetch, navigator, console });
  await flush();
  const iframe = nodes.views.children[0];
  document.activeElement = iframe;
  const message = (source, text, origin = location.origin) => listeners.message({ source, origin, data: { type: 'terminal-clipboard', text } });
  message({}, 'wrong source');
  message(iframe.contentWindow, 'wrong origin', 'http://other.test');
  assert.deepEqual(writes, []);
  assert.ok(nodes['copy-selection'].hidden);
  message(iframe.contentWindow, 'fixture 中文');
  assert.equal(nodes['copy-selection'].hidden, false);
  nodes['copy-selection'].click();
  await flush();
  assert.equal(nodes['copy-selection'].hidden, false, 'a denied write remains available for retry');
  deny = false;
  nodes['copy-selection'].click();
  await flush();
  assert.deepEqual(writes, ['fixture 中文']);
  assert.equal(nodes['copy-selection'].hidden, true);
  message(iframe.contentWindow, 'stale selection');
  rows(nodes)[1].children[0].listeners.click({ detail: 1 });
  assert.equal(nodes['copy-selection'].hidden, true, 'switching tabs clears the pending selection');
  message(iframe.contentWindow, 'inactive');
  assert.equal(nodes['copy-selection'].hidden, true, 'inactive frames cannot offer a copy');
});
