'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

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
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  focus() {}
  scrollIntoView() {}
  click() { if (!this.hidden && !this.disabled) this.listeners.click?.(); }
}

test('session auth failure and iframe disconnect offer safe explicit recovery', async () => {
  const nodes = Object.fromEntries(['tabs', 'views', 'status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection'].map(id => [id, new Element()]));
  const document = { querySelector: selector => nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  const listeners = {};
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; } };
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
  assert.equal(nodes['new-tab'].disabled, false);
  const message = (source, state, origin = location.origin) => listeners.message({ source, origin, data: { type: 'terminal-connection', state } });
  message(first.contentWindow, 'Connected');
  assert.equal(nodes.status.textContent, 'Connected');
  message({}, 'Disconnected');
  message(first.contentWindow, 'Disconnected', 'http://other.test');
  assert.equal(nodes.status.textContent, 'Connected', 'unrelated windows and origins must not change state');

  message(first.contentWindow, 'Disconnected');
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
  assert.equal(mutationRequests, 0, 'retry must not create a session or submit a command');
});
