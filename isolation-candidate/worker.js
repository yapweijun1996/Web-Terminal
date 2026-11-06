'use strict';
const fs = require('node:fs');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createPublicKey } = require('node:crypto');
const { createPolicy } = require('./policy');
const mode = process.argv[2];
let input = '';
process.stdin.on('data', b => { input += b; if (input.length > 65536) process.exit(2); });
process.stdin.on('end', async () => {
  try {
    const c = JSON.parse(input);
    const identity = { uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), capEff: fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+(\w+)/m)[1] };
    if (mode === 'identity') return console.log(JSON.stringify(identity));
    if (mode === 'traverse') {
      try { fs.readdirSync(c.path); console.log(JSON.stringify({ ...identity, ok: true })); }
      catch (e) { console.log(JSON.stringify({ ...identity, error: e.code })); }
      return;
    }
    if (mode === 'probe' || mode === 'request') {
      const socket = net.createConnection(c.path); let data = '';
      const timer = setTimeout(() => socket.destroy(Error('TIMEOUT')), 2000);
      socket.on('connect', () => { if (mode === 'probe') socket.end(); else socket.end(JSON.stringify(c.request) + '\n'); });
      socket.on('data', b => { data += b; if (data.length > 16384) socket.destroy(Error('TOO_LARGE')); });
      socket.on('error', e => { clearTimeout(timer); console.log(JSON.stringify({ ...identity, error: e.code || e.message })); });
      socket.on('end', () => { clearTimeout(timer); console.log(JSON.stringify({ ...identity, ok: true, response: mode === 'request' && data ? JSON.parse(data) : null })); });
      return;
    }
    if (mode !== 'serve') throw Error('MODE');
    process.umask(0o077);
    const policy = createPolicy({ ...c, publicKey: createPublicKey(c.publicKey) });
    const sockets = new Set(); const servers = [];
    for (const path of c.fakeSockets) {
      const server = net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); s.end('fixture-live\n'); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); }); servers.push(server);
    }
    const server = net.createServer({ allowHalfOpen: true }, s => {
      sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); s.setTimeout(2000, () => s.destroy());
      let data = ''; let done = false;
      s.on('data', b => {
        if (done) return; data += b;
        if (Buffer.byteLength(data) > 12288) { done = true; s.end('{"ok":false,"error":"DENIED"}\n'); return; }
        if (!data.includes('\n')) return; done = true;
        try {
          if (data.indexOf('\n') !== data.length - 1) throw Error('FRAME');
          const claim = policy.authorize(JSON.parse(data));
          if (claim.op !== 'release') {
            const args = ['-S', c.tmuxSocket, 'send-keys', '-t', c.pane];
            if (claim.op === 'text') args.push('-l', '--', claim.text); else args.push('Enter');
            execFileSync('tmux', args, { timeout: 2000, env: { PATH: process.env.PATH, HOME: '/tmp', TERM: 'xterm' } });
          }
          s.end('{"ok":true}\n');
        } catch { s.end('{"ok":false,"error":"DENIED"}\n'); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.supervisorSocket, resolve); }); servers.push(server);
    console.log(JSON.stringify({ ...identity, ready: true }));
    process.on('SIGTERM', () => { for (const s of sockets) s.destroy(); for (const server of servers) server.close(); });
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
});
