'use strict';
// A separate untrusted process with the same kernel UID. No identity switching.
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const [binary, directory] = process.argv.slice(2);
const r = spawnSync(binary, [directory, String(process.geteuid())], { encoding: 'utf8', timeout: 3000 });
const socket = net.createConnection(path.join(directory, 'gateway.sock'));
socket.setTimeout(2000, () => { socket.destroy(); process.exitCode = 1; });
socket.on('connect', () => { socket.destroy(); process.exitCode = 1; });
socket.on('error', e => {
  process.send({ uid: process.geteuid(), refused: r.status !== 0 && /ERR_SAME_UID/.test(r.stderr), error: e.code });
  process.disconnect();
});
