'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ rejectStorage = false } = {}) {
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = '';
      this.classList = { toggle() {} }; this.dataset = {};
      if (tag === 'iframe') this.contentWindow = { focus() {} };
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
    click() { if (!this.hidden && !this.disabled) this.listeners.click?.({ detail: 0 }); }
  }
  const ids = ['tabs', 'views', 'status', 'detail-view', 'detail-link', 'scroll-status', 'retry', 'restore', 'new-tab', 'rename-tab', 'rename-form', 'rename-input', 'rename-cancel', 'rename-error', 'latest', 'image-results', 'image-notice', 'copy-selection'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes['rename-form'].hidden = true;
  const header = new Element();
  document = { activeElement: null, querySelector: selector => selector === 'header' ? header : nodes[selector.slice(1)], createElement: tag => new Element(tag) };
  const store = {}, calls = [];
  const localStorage = { getItem: key => store[key] ?? null, setItem: (key, value) => { if (rejectStorage) throw Error('Storage denied'); store[key] = value; } };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    return { ok: true, json: async () => ({ sessions: ['shared', 'web-aaaaaaaaaaaa', 'web-bbbbbbbbbbbb'], token: 'fixture-token' }) };
  };
  const context = vm.createContext({ document, window: { addEventListener() {}, createMobileKeys: () => ({ toggle: new Element(), panel: new Element(), reset() {}, resetIfTargetChanged() {} }) }, location: { origin: 'http://fixture.test' }, localStorage, fetch, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8'), context);
  return { nodes, document, store, calls };
}

test('keyboard navigation keeps focus and hiding another view preserves the active view', async () => {
  const f = fixture(); await flush();
  const tabs = f.nodes.tabs;
  const first = tabs.children[0].children[0]; first.focus();
  let prevented = false;
  first.listeners.keydown({ key: 'ArrowRight', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.document.activeElement.textContent, 'Terminal aaaaaaaaaaaa');
  assert.equal(f.document.activeElement.attributes['aria-pressed'], 'true');
  tabs.children[0].children[1].click();
  assert.equal(f.document.activeElement.textContent, 'Terminal aaaaaaaaaaaa', 'hiding a different view does not switch the active view');
  assert.equal(f.calls.some(call => call.method === 'POST'), false, 'hiding a view must not terminate a session');
});

test('renaming is browser-local, unique, and preserves an identifiable view', async () => {
  const f = fixture(); await flush();
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Build logs';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.equal(f.nodes.tabs.children[0].children[0].textContent, 'Build logs');
  assert.equal(f.nodes['detail-view'].textContent, '1 of 3', 'status details do not repeat user-provided names');
  assert.equal(f.nodes.views.children[0].title, 'Build logs');
  assert.match(f.store['linux-web-terminal-names-v1'], /Build logs/);
  assert.equal(f.document.activeElement, f.nodes['rename-tab']);
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Terminal aaaaaaaaaaaa';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.match(f.nodes['rename-error'].textContent, /different/);
  assert.equal(f.nodes.tabs.children[0].children[0].textContent, 'Build logs');
  assert.equal(f.calls.some(call => call.method === 'POST'), false, 'renaming does not mutate a tmux session');
});

test('a storage failure is reported without pretending the rename was saved', async () => {
  const f = fixture({ rejectStorage: true }); await flush();
  f.nodes['rename-tab'].click();
  f.nodes['rename-input'].value = 'Temporary name';
  f.nodes['rename-form'].listeners.submit({ preventDefault() {} });
  assert.match(f.nodes['rename-error'].textContent, /Unable to save/);
  assert.equal(f.nodes.tabs.children[0].children[0].textContent, 'Existing terminal');
});
