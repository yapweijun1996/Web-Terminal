'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../client/node_modules/typescript');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../client/src/components/terminal/xterm/osc52-clipboard.ts'), 'utf8');
const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function fixture() {
  const elementEvents = {}, windowEvents = {}, writes = [], timers = new Map();
  let now = 1000, handler, timerId = 0, selected = false, disposed = false;
  const element = {
    addEventListener: (name, cb) => { elementEvents[name] = cb; },
    removeEventListener: name => { delete elementEvents[name]; },
  };
  const window = {
    addEventListener: (name, cb) => { windowEvents[name] = cb; },
    removeEventListener: name => { delete windowEvents[name]; },
  };
  const terminal = { element, hasSelection: () => selected,
    parser: { registerOscHandler: (_id, cb) => { handler = cb; return { dispose: () => { disposed = true; } }; } } };
  const api = {};
  vm.runInNewContext(script, { exports: api, window, document: { hasFocus: () => true },
    navigator: { clipboard: { writeText: value => { writes.push(value); return Promise.resolve(); } } },
    Date: { now: () => now }, TextDecoder, Uint8Array, atob,
    setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id) });
  const bridge = api.createOsc52Clipboard(terminal);
  return {
    bridge, writes, elementEvents, windowEvents,
    osc: data => handler(data),
    drag: (trusted = true) => {
      elementEvents.pointerdown({ isTrusted: trusted, button: 0, clientX: 0, clientY: 0 });
      windowEvents.pointerup({ isTrusted: trusted, button: 0, clientX: 20, clientY: 0 });
    },
    advance: ms => { now += ms; },
    expire: () => { for (const cb of [...timers.values()]) cb(); },
    select: value => { selected = value; },
    disposed: () => disposed,
  };
}

test('tmux copy is accepted only after a trusted, recent selection drag', () => {
  const f = fixture();
  const data = 'c;' + Buffer.from('copy 中文 ✓').toString('base64');
  f.osc(data);
  f.drag(false); f.osc(data);
  f.drag(); f.advance(1501); f.osc(data);
  assert.deepEqual(f.writes, []);
  f.drag(); f.osc(data);
  assert.deepEqual(f.writes, ['copy 中文 ✓']);
  assert.equal(f.bridge.hasPending(), true);
  f.expire();
  assert.equal(f.bridge.hasPending(), false);
});

test('Ctrl+C fallback copies the pending selection and cleanup removes it', () => {
  const f = fixture();
  f.drag(); f.osc('c;' + Buffer.from('selected output').toString('base64'));
  let text, prevented = false;
  f.elementEvents.copy({ clipboardData: { setData: (_type, value) => { text = value; } }, preventDefault: () => { prevented = true; } });
  assert.equal(text, 'selected output');
  assert.equal(prevented, true);
  assert.equal(f.bridge.hasPending(), false);
  f.drag(); f.osc('c;?');
  assert.equal(f.bridge.hasPending(), false, 'clipboard reads must not be accepted');
  f.bridge.dispose();
  assert.equal(f.disposed(), true);
  assert.equal(f.elementEvents.copy, undefined);
});

test('an ordinary click, malformed payloads, and unsolicited output do not write the clipboard', () => {
  const f = fixture();
  const data = 'c;' + Buffer.from('unexpected clipboard text').toString('base64');
  f.elementEvents.pointerdown({ isTrusted: true, button: 0, clientX: 0, clientY: 0 });
  f.windowEvents.pointerup({ isTrusted: true, button: 0, clientX: 1, clientY: 1 });
  f.osc(data);
  assert.deepEqual(f.writes, []);
  f.drag(); f.osc('c;?');
  f.osc(data);
  assert.deepEqual(f.writes, [], 'a rejected OSC must not allow a later unsolicited write');
  f.drag(); f.osc('c;' + 'A'.repeat(1400001));
  assert.equal(f.bridge.hasPending(), false);
});
