'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.disabled = false; this.hidden = false; this.textContent = ''; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  setAttribute() {}
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
  focus() {}
  select() {}
  click() { if (!this.disabled) return this.onclick?.(); }
}

function fixture({ captureFails = false } = {}) {
  const bar = new Element('nav'), body = new Element('body'), listeners = {}, requests = [], fetches = [];
  const document = {
    body,
    createElement: tag => new Element(tag),
    querySelector: selector => selector === '#remote-toolbar' ? bar : null,
    addEventListener: (name, listener) => { listeners[name] = listener; },
  };
  const ticket = 'a'.repeat(48);
  const target = { ticket, target: { windowIndex: '2', paneIndex: '0' } };
  let resolveCapture;
  const fetch = async (_url, options) => {
    const action = options.headers['X-Terminal-Action'];
    fetches.push({ action, ticket: options.headers['X-Terminal-Target'], pane: options.headers['X-Terminal-Pane'] });
    if (action === 'capture') {
      if (captureFails) return { ok: false };
      return new Promise(resolve => { resolveCapture = () => resolve({ ok: true, json: async () => target }); });
    }
    if (action === 'result') return { ok: true, json: async () => ({ path: '/tmp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', pending: false }) };
    return { ok: true };
  };
  class Xhr {
    constructor() { this.upload = {}; this.headers = {}; requests.push(this); }
    open() {}
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(file) { this.file = file; }
  }
  const window = { webTerminalViewId: 'view', webTerminalTarget: { session: 'view-fixture-1', pane: '%1' }, mbaTerminalReady: () => true, term: { options: { disableStdin: false } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../client/src/upload.js'), 'utf8'), {
    document, window, fetch, XMLHttpRequest: Xhr, AbortController, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, clearTimeout() {},
  });
  const trigger = () => listeners.paste({
    clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => ({ type: 'image/png', size: 8, name: 'fixture.png' }) }] },
    preventDefault() {}, stopImmediatePropagation() {},
  });
  const results = () => body.children.find(element => element.id === 'upload-results');
  return { window, trigger, results, requests, fetches, target, resolveCapture: () => resolveCapture() };
}

test('upload completion waits for explicit insertion into the captured pane', async () => {
  const f = fixture();
  f.trigger();
  assert.equal(f.window.term.options.disableStdin, true, 'input is paused while the target is captured');
  f.window.webTerminalTarget = { session: 'view-fixture-1', pane: '%2' };
  f.resolveCapture();
  await flush();
  assert.equal(f.fetches[0].pane, '%1', 'the request keeps the pane observed at upload start');
  assert.equal(f.window.term.options.disableStdin, false);
  assert.equal(f.requests[0].headers['X-Terminal-Target'], f.target.ticket);
  f.requests[0].status = 201;
  f.requests[0].responseText = JSON.stringify({ path: '/tmp/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', targetBound: true });
  f.requests[0].onload();
  const item = f.results().children[0];
  assert.match(item.children[0].textContent, /window 2, pane 0/);
  assert.deepEqual(f.fetches.map(request => request.action), ['capture'], 'completion must not silently insert');
  const insert = item.children.find(child => child.textContent === 'Insert into captured pane');
  await insert.click();
  assert.equal(insert.disabled, true, 'a repeat click cannot duplicate insertion');
  assert.equal(f.fetches[1].ticket, f.target.ticket);
  assert.equal(f.fetches[1].action, 'insert');
});

test('an interrupted upload offers recovery of the saved path', async () => {
  const f = fixture();
  f.trigger();
  f.resolveCapture();
  await flush();
  f.requests[0].onerror();
  const recovery = f.results().children[0].children.find(child => child.textContent === 'Recover saved path');
  await recovery.click();
  assert.equal(f.fetches[1].action, 'result');
  const saved = f.results().children[0];
  assert.ok(saved.children.some(child => child.tag === 'input' && child.value.endsWith('.png')));
  assert.ok(saved.children.some(child => child.textContent === 'Copy path'));
});

test('an upload does not start when no recovery receipt can be obtained', async () => {
  const f = fixture({ captureFails: true });
  f.trigger();
  await flush();
  assert.equal(f.requests.length, 0, 'a save must not start without a way to recover its result');
  assert.equal(f.window.term.options.disableStdin, false);
});
