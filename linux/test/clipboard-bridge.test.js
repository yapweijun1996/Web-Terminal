'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('clipboard bridge handles split tmux copies and ignores non-copy sequences', () => {
  const messages = [];
  class Socket {
    constructor() { this.listeners = {}; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    output(value, type = '0') {
      const bytes = new TextEncoder().encode(type + value);
      this.listeners.message({ data: bytes.buffer });
    }
  }
  const window = { WebSocket: Socket, location: { origin: 'https://fixture.test' }, parent: { postMessage: (message, origin) => messages.push({ message, origin }) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/clipboard-bridge.js'), 'utf8'), { window, TextDecoder, Uint8Array, ArrayBuffer, atob });
  const socket = new window.WebSocket();
  const encoded = Buffer.from('copy 中文 ✓').toString('base64');
  socket.output('plain\x1b]5');
  socket.output(`2;c;${encoded.slice(0, 7)}`);
  socket.output(`${encoded.slice(7)}\x1b\\`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.text, 'copy 中文 ✓');
  assert.equal(messages[0].origin, 'https://fixture.test');
  socket.output('\x1b]52;c;?\x07\x1b]52;c;%%%\x07');
  socket.output(`\x1b]52;c;${encoded}\x07`, '1');
  assert.equal(messages.length, 1);
});
