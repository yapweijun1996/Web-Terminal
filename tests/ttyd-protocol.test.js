'use strict';
// Protocol probe only: this is not a WebSocket implementation for a gateway.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

test('installed ttyd accepts the client handshake and input prefix', { timeout: 7000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mba-ttyd-protocol-'));
  const socketPath = path.join(dir, 'tty.sock');
  const ttyd = spawn('ttyd', ['-i', socketPath, '-W', '/bin/cat'], { stdio: 'ignore' });
  let socket;
  try {
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (fs.existsSync(socketPath)) { clearInterval(timer); resolve(); } }, 20);
      ttyd.once('exit', () => { clearInterval(timer); reject(Error('ttyd exited before listening')); });
    });
    socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const key = randomBytes(16).toString('base64');
    socket.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: tty\r\n\r\n`);
    let buffer = Buffer.alloc(0), upgraded = false, sent = false;
    const send = data => {
      const payload = Buffer.from(data); const mask = randomBytes(4);
      assert.ok(payload.length < 126);
      const frame = Buffer.alloc(6 + payload.length); frame[0] = 0x82; frame[1] = 0x80 | payload.length; mask.copy(frame, 2);
      for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
      socket.write(frame);
    };
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('ttyd output timeout')), 3000);
      socket.on('error', reject);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!upgraded) {
          const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
          if (!buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101 ')) return reject(Error('Upgrade failed'));
          buffer = buffer.subarray(end + 4); upgraded = true;
          send(JSON.stringify({ AuthToken: '', columns: 80, rows: 24 }));
          send('0MBA_PROTOCOL_PROBE\r'); sent = true;
        }
        // The marker is ASCII and may be framed alongside terminal output.
        if (sent && buffer.includes(Buffer.from('MBA_PROTOCOL_PROBE'))) { clearTimeout(timeout); resolve(); }
      });
    });
  } finally {
    if (socket) socket.destroy();
    if (ttyd.exitCode === null && ttyd.signalCode === null) {
      const exited = new Promise(resolve => ttyd.once('exit', resolve));
      ttyd.kill('SIGTERM'); await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
