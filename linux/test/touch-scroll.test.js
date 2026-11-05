'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { installTerminalTouchScroll } = require('../ui/touch-scroll');

function fixture(mode = 'vt200') {
  const handlers = {}, wheels = [], scrolls = [];
  let time = 0;
  const element = {
    contains: target => target === element,
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, right: 390, top: 0, bottom: 600, height: 600 }) }),
    dispatchEvent: event => wheels.push(event),
  };
  const terminal = { element, rows: 30, options: {}, modes: { mouseTrackingMode: mode }, scrollLines: lines => scrolls.push(lines) };
  let active = terminal;
  const document = {
    head: { append() {} }, createElement: () => ({ remove() {} }),
    defaultView: { WheelEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } } },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    removeEventListener: type => { delete handlers[type]; },
  };
  const installed = installTerminalTouchScroll(document, () => active, () => time);
  const touch = (y, x = 100, identifier = 1) => ({ identifier, clientX: x, clientY: y });
  const fire = (type, touches = []) => {
    const event = { touches, target: element, cancelable: true,
      preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
    handlers[type](event); return event;
  };
  return { terminal, wheels, scrolls, fire, touch, installed, handlers,
    advance: ms => { time += ms; }, switchTerminal: () => { active = { ...terminal }; } };
}

test('single-finger drag scrolls in both directions with bounded wheel reports', () => {
  const f = fixture();
  assert.ok(!f.fire('touchstart', [f.touch(300)]).prevented, 'tap stays native');
  assert.ok(f.fire('touchmove', [f.touch(360)]).prevented);
  assert.deepEqual(f.wheels.map(e => e.deltaY), [-1, -1, -1]);
  f.fire('touchmove', [f.touch(280)]);
  assert.deepEqual(f.wheels.slice(3).map(e => e.deltaY), [1, 1, 1, 1]);
  assert.ok(f.fire('touchend').prevented, 'drag does not focus the soft keyboard');
  assert.deepEqual(f.scrolls, []);
  f.installed.dispose(); assert.deepEqual(Object.keys(f.handlers), []);
});

test('non-mouse buffers use scrollLines without sending application input', () => {
  const f = fixture('none');
  f.fire('touchstart', [f.touch(200)]); f.fire('touchmove', [f.touch(260)]);
  assert.deepEqual(f.scrolls, [-3]); assert.deepEqual(f.wheels, []);
});

test('small deltas accumulate, horizontal drags and long press do not scroll', () => {
  const f = fixture();
  f.fire('touchstart', [f.touch(200)]);
  f.fire('touchmove', [f.touch(210)]); f.fire('touchmove', [f.touch(221)]);
  assert.equal(f.wheels.length, 1);
  for (const kind of ['horizontal', 'hold']) {
    f.fire('touchstart', [f.touch(200)]);
    if (kind === 'hold') f.advance(500);
    f.fire('touchmove', [f.touch(202, kind === 'horizontal' ? 150 : 100)]);
    f.fire('touchmove', [f.touch(300)]);
  }
  assert.equal(f.wheels.length, 1);
});

test('pinch, cancel, selection, disconnect and terminal switch abandon a gesture', () => {
  for (const action of ['pinch', 'cancel', 'selection', 'disconnect', 'switch']) {
    const f = fixture(); f.fire('touchstart', [f.touch(200)]);
    if (action === 'pinch') f.fire('touchmove', [f.touch(210), f.touch(210, 200, 2)]);
    if (action === 'cancel') f.fire('touchcancel');
    if (action === 'selection') f.terminal.hasSelection = () => true;
    if (action === 'disconnect') f.terminal.options.disableStdin = true;
    if (action === 'switch') f.switchTerminal();
    f.fire('touchmove', [f.touch(300)]);
    assert.equal(f.wheels.length, 0, action);
  }
});
