'use strict';
// Small bounded RFC6455 transport for this local demo. Fragmented messages and
// extensions are deliberately unsupported and fail closed.
const { createHash, randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const accept = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
function frame(data, masked = false, opcode = 2) {
  data = Buffer.from(data); const n = data.length;
  if (n > 1048576) throw Error('Frame too large');
  const header = Buffer.alloc(n < 126 ? 2 : n < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode; header[1] = (masked ? 128 : 0) | (n < 126 ? n : n < 65536 ? 126 : 127);
  if (n >= 126 && n < 65536) header.writeUInt16BE(n, 2);
  if (n >= 65536) header.writeBigUInt64BE(BigInt(n), 2);
  if (!masked) return Buffer.concat([header, data]);
  const mask = randomBytes(4), copy = Buffer.from(data);
  for (let i = 0; i < n; i++) copy[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, copy]);
}
function transport(socket, { client = false, max = 16384 } = {}) {
  const bus = new EventEmitter(); let pending = Buffer.alloc(0), closed = false;
  bus.on('error', () => {});
  bus.send = (data, opcode = client ? 2 : 1) => {
    if (closed || socket.destroyed) return;
    if (socket.writableLength > 1048576) return bus.close();
    socket.write(frame(data, client, opcode));
  };
  bus.close = () => { closed = true; socket.destroy(); };
  socket.on('close', () => { closed = true; bus.emit('close'); });
  socket.on('error', e => { bus.emit('error', e); bus.close(); });
  bus.feed = chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 15, masked = Boolean(pending[1] & 128);
      if (!(pending[0] & 128) || (pending[0] & 112) || masked === client || ![1, 2, 8, 9, 10].includes(opcode)) return bus.close();
      let n = pending[1] & 127, off = 2;
      if (n === 126) { if (pending.length < 4) return; n = pending.readUInt16BE(2); off = 4; }
      else if (n === 127) { if (pending.length < 10) return; const big = pending.readBigUInt64BE(2); if (big > BigInt(max)) return bus.close(); n = Number(big); off = 10; }
      if (n > max || (opcode >= 8 && n > 125)) return bus.close();
      const start = off + (masked ? 4 : 0);
      if (pending.length < start + n) return;
      const data = Buffer.from(pending.subarray(start, start + n));
      if (masked) for (let i = 0; i < n; i++) data[i] ^= pending[off + i % 4];
      pending = pending.subarray(start + n);
      if (opcode === 8) return bus.close();
      if (opcode === 9) bus.send(data, 10);
      else if (opcode === 10) bus.emit('pong');
      else if (opcode < 8) bus.emit('message', data, opcode);
    }
  };
  socket.on('data', bus.feed);
  return bus;
}
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key || '')) throw Error('Invalid upgrade');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\n\r\n`);
  const bus = transport(socket);
  // Caller installs authorization-bound handlers before any pipelined frame.
  queueMicrotask(() => { if (head.length) bus.feed(head); });
  return bus;
}
function watch(socketPath, onOutput) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), key = randomBytes(16).toString('base64');
    let header = Buffer.alloc(0), bus;
    const timer = setTimeout(() => { socket.destroy(); reject(Error('Watcher timeout')); }, 5000);
    const fail = e => { clearTimeout(timer); reject(e); };
    socket.once('error', fail);
    socket.once('close', () => { if (!bus) fail(Error('Watcher closed before upgrade')); });
    socket.on('connect', () => socket.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tty\r\n\r\n`));
    const receive = chunk => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) { if (header.length > 8192) { socket.destroy(); fail(Error('Invalid upstream')); } return; }
      const text = header.subarray(0, end).toString();
      if (!text.startsWith('HTTP/1.1 101 ') || !text.toLowerCase().includes(`sec-websocket-accept: ${accept(key)}`.toLowerCase())) { socket.destroy(); fail(Error('Invalid upstream')); return; }
      socket.removeListener('data', receive); clearTimeout(timer);
      bus = transport(socket, { client: true, max: 1048576 });
      const decoder = new TextDecoder();
      bus.on('message', data => { if (data[0] === 48) onOutput(decoder.decode(data.subarray(1), { stream: true })); });
      bus.send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
      resolve(bus);
      if (header.length > end + 4) bus.feed(header.subarray(end + 4));
    };
    socket.on('data', receive);
  });
}
module.exports = { upgrade, watch, frame };
