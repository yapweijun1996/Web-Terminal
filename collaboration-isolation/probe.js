'use strict';
// Manual, read-only probe. Run in the caller's own authorized login session.
// Never switches UID, changes permissions, or invokes a terminal command.
const fs = require('node:fs');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const [mode, target] = process.argv.slice(2);
if (process.argv.length !== 4 || !['ping', 'deny-socket', 'deny-file'].includes(mode) ||
    !target || !path.isAbsolute(target)) {
  console.error('Usage: node probe.js ping|deny-socket|deny-file /absolute/scratch/path');
  process.exit(64);
}
function denied(error) { return error && ['EACCES', 'EPERM'].includes(error.code); }
if (mode === 'deny-file') {
  let fd;
  try { fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (e) {
    if (!denied(e)) { console.error(`FAIL ${e.code}; missing paths are not isolation proof`); process.exit(1); }
    console.log(`DENIED uid=${process.geteuid()} code=${e.code}`); process.exit(0);
  }
  fs.closeSync(fd); console.error('FAIL readable'); process.exit(1);
}
const nonce = crypto.randomBytes(16).toString('hex');
const socket = net.createConnection(target); let reply = ''; let complete = false;
socket.setTimeout(2000, () => { console.error('FAIL timeout'); socket.destroy(); process.exitCode = 1; });
socket.on('connect', () => {
  if (mode === 'deny-socket') {
    console.error('FAIL connected'); socket.destroy(); process.exitCode = 1;
  } else socket.end(`PING ${nonce}\n`);
});
socket.on('data', chunk => {
  reply += chunk;
  if (reply.length > 128) { socket.destroy(); process.exitCode = 1; }
});
socket.on('error', e => {
  complete = true;
  if (mode === 'deny-socket' && denied(e)) console.log(`DENIED uid=${process.geteuid()} code=${e.code}`);
  else { console.error(`FAIL ${e.code}`); process.exitCode = 1; }
});
socket.on('close', () => {
  if (complete || process.exitCode) return;
  if (mode === 'ping' && new RegExp(`^PONG ${nonce} UID ${process.geteuid()} GID [0-9]+\\n$`).test(reply)) {
    console.log(`KERNEL_REPLY ${reply.trim()}`);
  } else { console.error('FAIL missing or invalid reply'); process.exitCode = 1; }
});
