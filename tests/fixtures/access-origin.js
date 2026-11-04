'use strict';

// An inert local fixture: it never starts a shell, reads user files, saves an
// upload, echoes request data, or authenticates a caller. Access belongs at
// the separately configured tunnel boundary, not in this test process.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const socketPath = process.env.WT_ACCESS_FIXTURE_SOCKET;
if (!socketPath || !path.isAbsolute(socketPath)) throw Error('An absolute fixture socket path is required');
const parent = fs.lstatSync(path.dirname(socketPath));
if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || (parent.mode & 0o077)) {
  throw Error('The fixture socket directory must be private and owned by the current user');
}
try { fs.lstatSync(socketPath); throw Error('The fixture socket path already exists'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.umask(0o077);

const instance = crypto.randomBytes(12).toString('hex');
const state = () => JSON.stringify({ fixture: true, instance, seconds: Math.floor(process.uptime()) });
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/token')) return reply(res, 200, state());
  if (req.method === 'POST' && req.url === '/__terminal_upload') {
    let size = 0;
    const deadline = setTimeout(() => req.destroy(), 5000);
    req.on('close', () => clearTimeout(deadline));
    req.on('data', chunk => { size += chunk.length; if (size > 256) req.destroy(); });
    req.on('end', () => { clearTimeout(deadline); if (size <= 256) reply(res, 200, JSON.stringify({ fixture: true, discarded: true })); });
    return;
  }
  reply(res, 404, '{"fixture":true,"error":"Not found"}');
});
let activeSockets = 0;
server.maxConnections = 16;
server.headersTimeout = 5000;
server.requestTimeout = 5000;
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16 || activeSockets >= 4) return socket.destroy();
  activeSockets++;
  const lifetime = setTimeout(() => socket.destroy(), 10 * 60 * 1000);
  const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const emit = () => {
    const payload = Buffer.from(state());
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  };
  emit();
  const timer = setInterval(emit, 3000);
  let received = 0;
  socket.on('data', data => {
    received += data.length;
    if ((data[0] & 0x0f) === 8) socket.end(Buffer.from([0x88, 0]));
    else if (received > 4096) socket.destroy();
  });
  socket.on('error', () => {});
  socket.on('end', () => socket.destroy());
  socket.on('close', () => { clearInterval(timer); clearTimeout(lifetime); activeSockets--; });
});
server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); console.log('Fixture origin listening'); });
