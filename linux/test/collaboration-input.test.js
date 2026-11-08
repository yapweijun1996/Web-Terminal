'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../ui/collaboration-input.js'), 'utf8');
function fixture({ defaultFalse = false, available = true } = {}) {
  const packets = [], socket = { send(data) { packets.push(Buffer.from(data)); return 'sent'; } };
  const term = { _core: {} };
  const service = { triggerDataEvent: defaultFalse ? { triggerDataEvent(data, user = false) { return socket.send(new TextEncoder().encode('0' + data)); } }.triggerDataEvent : function (data, user) { return socket.send(new TextEncoder().encode('0' + data)); } };
  if (available) term._core.coreService = service;
  term.input = data => service.triggerDataEvent(data, false);
  term.paste = data => service.triggerDataEvent(data, false);
  const context = { window: {}, TextEncoder, ArrayBuffer, Uint8Array }; vm.runInNewContext(source, context);
  context.window.installCollaborationInputProvenance(socket, () => term);
  return { socket, packets, service, term };
}
test('explicit xterm input provenance preserves raw bytes and public human/mobile/paste intent', () => {
  const f = fixture();
  assert.equal(f.service.triggerDataEvent('\x1b[3;4R', false), 'sent');
  assert.deepEqual(f.packets.pop(), Buffer.from('4\x1b[3;4R'));
  f.service.triggerDataEvent('\x1b[A', true); assert.deepEqual(f.packets.pop(), Buffer.from('0\x1b[A'));
  f.term.input('\t'); assert.deepEqual(f.packets.pop(), Buffer.from('0\t'));
  f.term.paste('中文\n'); assert.deepEqual(f.packets.pop(), Buffer.from('0中文\n'));
  f.service.triggerDataEvent('unknown'); assert.deepEqual(f.packets.pop(), Buffer.from('0unknown'));
  f.service.triggerDataEvent('null-provenance', null); assert.deepEqual(f.packets.pop(), Buffer.from('0null-provenance'));
  f.socket.send(new Uint8Array([48, 255, 0])); assert.deepEqual(f.packets.pop(), Buffer.from([48, 255, 0]));
});
test('only feature-confirmed default-false xterm normalizes omitted protocol provenance', () => {
  const f = fixture({ defaultFalse: true });
  f.service.triggerDataEvent('\x1b[?1;2c'); assert.equal(f.packets.pop()[0], 52);
  const unknown = fixture({ available: false });
  unknown.socket.send(Buffer.from('0opaque')); assert.deepEqual(unknown.packets.pop(), Buffer.from('0opaque'));
});

test('older native xterm gets an explicit human input adapter for mobile keys', () => {
  const packets = [], socket = { send: bytes => packets.push(Buffer.from(bytes)) };
  const term = { _core: { coreService: { triggerDataEvent(data, user = false) { socket.send(Buffer.from('0' + data)); } } } };
  const context = { window: {}, TextEncoder, ArrayBuffer, Uint8Array }; vm.runInNewContext(source, context);
  context.window.installCollaborationInputProvenance(socket, () => term);
  assert.equal(typeof term.input, 'function');
  term.input('\t', true); assert.deepEqual(packets.pop(), Buffer.from('0\t'));
});

test('frozen or unsupported xterm services retain ordinary fail-safe input', () => {
  const packets = [], socket = { send: bytes => packets.push(Buffer.from(bytes)) };
  const service = Object.freeze({ triggerDataEvent(data, user = false) { socket.send(Buffer.from('0' + data)); } });
  const term = { _core: { coreService: service } };
  const context = { window: {}, TextEncoder, ArrayBuffer, Uint8Array }; vm.runInNewContext(source, context);
  context.window.installCollaborationInputProvenance(socket, () => term);
  assert.doesNotThrow(() => socket.send(Buffer.from('0ordinary')));
  assert.deepEqual(packets.pop(), Buffer.from('0ordinary'));
});
