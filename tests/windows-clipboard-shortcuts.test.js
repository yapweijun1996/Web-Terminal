'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../client/node_modules/typescript');
const { test } = require('node:test');

const source = fs.readFileSync(require.resolve('../client/src/components/terminal/xterm/clipboard-shortcuts.ts'), 'utf8');
const script = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const shortcuts = {};
vm.runInNewContext(script, { exports: shortcuts });

function key(key, overrides = {}) {
  return { type: 'keydown', key, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...overrides };
}

test('Windows clipboard shortcuts leave paste and selected text copy to the browser', () => {
  assert.equal(shortcuts.useTerminalKey(key('v'), 'Win32', false), false);
  assert.equal(shortcuts.useTerminalKey(key('c'), 'Win32', true), false);
  assert.equal(shortcuts.useTerminalKey(key('c'), 'Win32', false), true);
});

test('other platforms, modifiers and terminal control keys retain their normal handling', () => {
  assert.equal(shortcuts.useTerminalKey(key('v'), 'MacIntel', false), true);
  assert.equal(shortcuts.useTerminalKey(key('v'), 'Linux x86_64', false), true);
  assert.equal(shortcuts.useTerminalKey(key('v', { altKey: true }), 'Win32', false), true);
  assert.equal(shortcuts.useTerminalKey(key('v', { shiftKey: true }), 'Win32', false), true);
  assert.equal(shortcuts.useTerminalKey(key('d'), 'Win32', true), true);
  assert.equal(shortcuts.useTerminalKey(key('v', { type: 'keyup' }), 'Win32', false), true);
});
