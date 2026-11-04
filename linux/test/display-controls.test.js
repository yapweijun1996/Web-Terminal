'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('display controls adjust the active terminal without sending input', () => {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.attributes = {}; this.textContent = ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    append(...children) { this.children.push(...children); }
    click() { this.listeners.click?.(); }
  }
  const document = { createElement: () => new Element() }, window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/display-controls.js'), 'utf8'), { document, window });
  let active = null, fits = 0;
  const display = window.createTerminalDisplayControls({ getTerminal: () => active, fit: () => fits++ });
  const [smaller, larger, contrast, status] = display.element.children[1].children;
  larger.click();
  assert.match(status.textContent, /when the terminal connects/);
  active = { options: { fontSize: 16, minimumContrastRatio: 1 }, input() { assert.fail('must not send terminal input'); } };
  display.apply();
  assert.equal(active.options.fontSize, 18);
  assert.equal(fits, 1);
  contrast.click();
  assert.equal(active.options.minimumContrastRatio, 4.5);
  assert.equal(contrast.attributes['aria-pressed'], 'true');
  smaller.click();
  assert.equal(active.options.fontSize, 16);
  for (let i = 0; i < 20; i++) larger.click();
  assert.equal(active.options.fontSize, 30);
  smaller.click();
  assert.equal(active.options.fontSize, 28, 'decreasing after the upper limit takes effect immediately');
  contrast.click();
  assert.equal(active.options.minimumContrastRatio, 1);
  const other = { options: { fontSize: 14, minimumContrastRatio: 1 } };
  active = other; display.apply();
  assert.equal(other.options.fontSize, 26, 'a new view uses its own original size');
  active = { options: { fontSize: 14 } }; display.apply();
  contrast.click();
  assert.equal(contrast.attributes['aria-pressed'], 'false');
  assert.match(status.textContent, /contrast unavailable/);
});
