'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('mobile keys send only explicit input to a ready terminal', () => {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.value = ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    append(...children) { this.children.push(...children); }
    click(detail = 0) { this.listeners.click?.({ detail }); }
  }
  const document = { createElement: () => new Element() }, window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/mobile-keys.js'), 'utf8'), { document, window });
  const input = [], focus = [];
  let target = 'fixture-pane';
  let terminal = { input: data => input.push(data), focus: () => focus.push(true), options: { disableStdin: false }, modes: { applicationCursorKeysMode: false } };
  const controls = window.createMobileKeys({ getTerminal: () => terminal, getTargetKey: () => target });
  assert.equal(controls.panel.hidden, true);
  controls.toggle.click();
  assert.equal(controls.toggle.attributes['aria-expanded'], 'true');
  const [esc, tab, left, up, , , label, send, notice] = controls.panel.children;
  esc.click(); tab.click(); left.click();
  assert.deepEqual(input, ['\x1b', '\t', '\x1b[D']);
  assert.equal(focus.length, 0, 'keyboard operation keeps focus on the control');
  terminal.modes.applicationCursorKeysMode = true;
  up.click(1);
  assert.equal(input.at(-1), '\x1bOA');
  assert.equal(focus.length, 1, 'pointer input returns focus to the terminal');
  const select = label.children[0];
  assert.ok(!select.children.some(option => ['10', '13'].includes(option.value)), 'Ctrl+J/M cannot submit');
  select.value = '3'; select.listeners.change(); send.click();
  assert.equal(input.at(-1), '\x03');
  assert.equal(select.value, '', 'the selected modifier is cleared after one explicit send');
  const count = input.length;
  select.value = '3'; select.listeners.change(); target = 'different-pane'; send.click();
  assert.equal(input.length, count, 'a control choice cannot follow a pane switch');
  assert.equal(select.value, '');
  select.value = '3'; select.listeners.change(); target = 'another-pane'; controls.resetIfTargetChanged();
  assert.equal(select.value, '', 'a pane change clears the pending choice');
  select.value = '3'; select.listeners.change(); controls.reset();
  assert.equal(select.value, '', 'disconnect clears the pending choice even if the pane later returns');
  select.value = '13'; send.click();
  assert.equal(input.length, count, 'a crafted Ctrl+M selection cannot send Enter');
  terminal.modes = {}; left.click();
  assert.equal(input.length, count, 'unknown cursor mode does not guess');
  assert.match(notice.textContent, /unavailable/);
  terminal.options.disableStdin = true; esc.click();
  assert.equal(input.length, count, 'disabled input is not queued');
  terminal = null; tab.click();
  assert.equal(input.length, count, 'disconnected input is not queued');
  controls.toggle.click();
  assert.equal(controls.toggle.attributes['aria-expanded'], 'false');
  assert.equal(select.value, '');
});
