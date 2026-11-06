'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync, fork } = require('node:child_process');
const { once } = require('node:events');
const source = path.resolve(__dirname, '../collaboration-isolation');
const uid = process.geteuid();
const other = uid === 4294967294 ? 4294967293 : uid + 1;
const nonce = '0123456789abcdef0123456789abcdef';
const ping = `PING ${nonce}\n`;
const delay = ms => new Promise(r => setTimeout(r, ms));

test('isolated native macOS socket candidate', { timeout: 60000 }, async t => {
  const root = fs.mkdtempSync('/private/tmp/mba-iso-');
  fs.chmodSync(root, 0o700);
  const children = new Set();
  let index = 0;
  const fresh = () => { const d = path.join(root, `d${index++}`); fs.mkdirSync(d, { mode: 0o700 }); return d; };
  const bin = name => path.join(root, name);
  const run = (name, args) => spawnSync(bin(name), args, { encoding: 'utf8', timeout: 5000 });
  async function start(name, dir, expected = uid) {
    const p = spawn(bin(name), [dir, String(expected)], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(p);
    p.logs = ''; p.output = '';
    p.stderr.on('data', b => p.logs += b);
    p.stdout.on('data', b => p.output += b);
    p.done = once(p, 'exit');
    p.once('exit', () => children.delete(p));
    for (let i = 0; i < 300 && !p.output.includes('READY') && p.exitCode === null; i++) await delay(10);
    assert.match(p.output, /READY/, p.logs);
    return p;
  }
  async function request(dir, frame = ping, end = true) {
    const socket = net.createConnection(path.join(dir, 'gateway.sock'));
    let reply = ''; socket.on('data', b => reply += b);
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.setTimeout(3000, () => socket.destroy(new Error('test timeout')));
    await once(socket, 'connect');
    if (end) socket.end(frame); else if (frame) socket.write(frame);
    await closed; return reply;
  }
  async function finish(p, code) {
    const [actual] = await p.done;
    assert.equal(actual, code, p.logs);
  }
  function refused(dir, expected, pattern, name = 'supervisor') {
    const r = run(name, [dir, String(expected)]);
    assert.notEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, pattern);
    assert.equal(fs.existsSync(path.join(dir, 'gateway.sock')), false);
  }
  try {
    await t.test('clang builds separate enforcement, diagnostic, and unsupported binaries', () => {
      for (const name of ['supervisor', 'diagnostic']) {
        const r = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
          path.join(source, `${name}.c`), path.join(source, 'socket.c'), '-o', bin(name)], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
      }
      const r = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-U__APPLE__',
        path.join(source, 'supervisor.c'), path.join(source, 'socket.c'), '-o', bin('unsupported')], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    });
    if (!fs.existsSync(bin('supervisor'))) return;
    await t.test('unsupported platform branch creates no socket', () => {
      const d = fresh(); const r = run('unsupported', [d, String(other)]);
      assert.equal(r.status, 77); assert.match(r.stderr, /ERR_UNSUPPORTED/);
      assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    if (process.platform !== 'darwin') {
      console.log('MACOS_KERNEL_TESTS=NOT_RUN; DUAL_PRINCIPAL=NOT_RUN/P0'); return;
    }
    await t.test('same UID enforcement startup refused unconditionally, including hostile env flags', () => {
      const d = fresh();
      const r = spawnSync(bin('supervisor'), [d, String(uid)], { encoding: 'utf8', env: {
        ...process.env, ALLOW_SAME_UID: '1', DIAGNOSTIC: '1', EXPECTED_UID: String(other)
      } });
      assert.notEqual(r.status, 0); assert.match(r.stderr, /ERR_SAME_UID/);
      assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('forked untrusted same UID child gets refusal and cannot connect', async () => {
      const d = fresh(); const child = fork(path.join(source, 'refusal-child.js'), [bin('supervisor'), d],
        { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      children.add(child); const done = once(child, 'exit');
      const [msg] = await once(child, 'message');
      const [code] = await done; children.delete(child);
      assert.equal(code, 0); assert.equal(msg.uid, uid); assert.equal(msg.error, 'ENOENT');
      assert.equal(msg.refused, true);
    });
    await t.test('diagnostic obtains actual kernel UID/GID with AF_UNIX; private modes; no TCP', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      const st = fs.lstatSync(path.join(d, 'gateway.sock'));
      assert.ok(st.isSocket()); assert.equal(st.uid, uid); assert.equal(st.mode & 0o7777, 0o600);
      assert.equal(fs.statSync(d).mode & 0o7777, 0o700);
      const tcp = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(p.pid), '-iTCP'], { encoding: 'utf8' });
      assert.equal(tcp.status, 1, tcp.stdout + tcp.stderr); assert.equal(tcp.stdout, '');
      const reply = await request(d);
      assert.equal(reply, `PONG ${nonce} UID ${uid} GID ${process.getegid()}\n`);
      console.log(`KERNEL_DIAGNOSTIC=${reply.trim()}`);
      await finish(p, 0);
      assert.match(p.logs, new RegExp(`PEER uid=${uid} gid=${process.getegid()}`));
      assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('configured UID mismatch denies actual same UID in live enforcement (not two UID E2E)', async () => {
      const d = fresh(); const p = await start('supervisor', d, other);
      const tcp = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(p.pid), '-iTCP'], { encoding: 'utf8' });
      assert.equal(tcp.status, 1); assert.equal(tcp.stdout, '');
      assert.equal(await request(d, `{"uid":${other},"token":"forged"}\n`), '');
      p.kill('SIGTERM'); await p.done;
      assert.match(p.logs, /ERR_DENIED/);
      assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('diagnostic mismatched expected UID denies kernel peer', async () => {
      const d = fresh(); const p = await start('diagnostic', d, other);
      assert.equal(await request(d), ''); await finish(p, 72);
    });
    await t.test('symlink directory and symlink ancestor refused', () => {
      const target = fresh(); const link = path.join(root, 'link'); fs.symlinkSync(target, link);
      refused(link, other, /ERR_PATH/);
      const inner = path.join(target, 'inner'); fs.mkdirSync(inner, { mode: 0o700 });
      refused(path.join(link, 'inner'), other, /ERR_PATH/);
    });
    await t.test('non-private, relative, traversal, overlong, malformed UID and extra args refused', () => {
      for (const mode of [0o755, 0o770, 0o1700]) {
        const d = fresh(); fs.chmodSync(d, mode); refused(d, other, /ERR_DIRECTORY/);
      }
      refused('relative', other, /ERR_PATH/);
      refused(root + '/../' + path.basename(root), other, /ERR_PATH/);
      refused('/' + 'x'.repeat(200), other, /ERR_PATH/);
      for (const value of ['-1', '0', '4294967295', '12abc', '+501', ' 501', '']) refused(fresh(), value, /ERR_UID/);
      const d = fresh(); const r = run('supervisor', [d, String(other), '--allow-same-uid']);
      assert.match(r.stderr, /ERR_ARGS/); assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('nonempty directory and socket symlink preserved on refusal', () => {
      const d = fresh(); fs.writeFileSync(path.join(d, 'sentinel'), 'preserve');
      refused(d, other, /ERR_NOT_EMPTY/);
      assert.equal(fs.readFileSync(path.join(d, 'sentinel'), 'utf8'), 'preserve');
      const e = fresh(); fs.symlinkSync(path.join(d, 'sentinel'), path.join(e, 'gateway.sock'));
      const r = run('supervisor', [e, String(other)]); assert.match(r.stderr, /ERR_NOT_EMPTY/);
      assert.ok(fs.lstatSync(path.join(e, 'gateway.sock')).isSymbolicLink());
    });
    await t.test('duplicate live server and stale socket fail closed without unlinking', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      const before = fs.lstatSync(path.join(d, 'gateway.sock')).ino;
      const collision = run('supervisor', [d, String(other)]);
      assert.notEqual(collision.status, 0); assert.match(collision.stderr, /ERR_(LOCK|NOT_EMPTY)/);
      assert.equal(fs.lstatSync(path.join(d, 'gateway.sock')).ino, before);
      p.kill('SIGKILL'); await p.done;
      const stale = run('supervisor', [d, String(other)]);
      assert.notEqual(stale.status, 0); assert.match(stale.stderr, /ERR_NOT_EMPTY/);
      assert.equal(fs.lstatSync(path.join(d, 'gateway.sock')).ino, before);
    });
    await t.test('strict bounded frames: forged UID, command, NUL, extra data, overlength and incomplete EOF', async () => {
      for (const frame of ['{"uid":0}\n', 'send-keys whoami\n', `PING ${nonce}\0\n`, ping + ping,
        'x'.repeat(1024), `PING ${nonce.toUpperCase()}\n`, 'PING short\n', ping.slice(0, -1)]) {
        const d = fresh(); const p = await start('diagnostic', d);
        assert.equal(await request(d, frame), ''); await finish(p, 73);
        assert.match(p.logs, /ERR_FRAME/);
      }
    });
    await t.test('connection deadline defeats idle and slow incomplete input', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      assert.equal(await request(d, 'P', false), ''); await finish(p, 74);
      assert.match(p.logs, /ERR_TIMEOUT/);
    });
    await t.test('no-client idle deadline cleans socket', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      await finish(p, 74); assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('enforcement lifetime bounded to 16 denied connections', async () => {
      const d = fresh(); const p = await start('supervisor', d, other);
      for (let i = 0; i < 16; i++) assert.equal(await request(d), '');
      await finish(p, 0); assert.equal((p.logs.match(/ERR_DENIED/g) || []).length, 16);
      assert.equal(fs.existsSync(path.join(d, 'gateway.sock')), false);
    });
    await t.test('changed directory permissions cause fail closed before response', async () => {
      const d = fresh(); const p = await start('diagnostic', d); fs.chmodSync(d, 0o755);
      assert.equal(await request(d), ''); await finish(p, 71);
    });
    await t.test('changed socket mode and replaced socket symlink deny responses; replacement preserved', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      fs.chmodSync(path.join(d, 'gateway.sock'), 0o666);
      assert.equal(await request(d), ''); await finish(p, 71);
      const e = fresh(); const q = await start('diagnostic', e);
      const socketPath = path.join(e, 'gateway.sock');
      const connection = net.createConnection(socketPath);
      connection.on('error', () => {});
      const closed = new Promise(resolve => connection.once('close', resolve));
      let reply = ''; connection.on('data', b => reply += b);
      await once(connection, 'connect');
      fs.unlinkSync(socketPath);
      const sentinel = path.join(root, 'replacement-sentinel'); fs.writeFileSync(sentinel, 'preserve');
      fs.symlinkSync(sentinel, socketPath);
      connection.end(ping); await closed; await finish(q, 71);
      assert.equal(reply, ''); assert.ok(fs.lstatSync(socketPath).isSymbolicLink());
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
    });
    await t.test('manual read-only probe validates ping and rejects missing/readable paths as denial proof', async () => {
      const d = fresh(); const p = await start('diagnostic', d);
      const probe = path.join(source, 'probe.js');
      const result = spawnSync(process.execPath, [probe, 'ping', path.join(d, 'gateway.sock')], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /KERNEL_REPLY PONG/);
      await finish(p, 0);
      const file = path.join(root, 'readable'); fs.writeFileSync(file, 'unchanged');
      for (const [mode, target] of [['deny-file', file], ['deny-file', file + '-missing'], ['deny-socket', path.join(d, 'gateway.sock')]]) {
        const negative = spawnSync(process.execPath, [probe, mode, target], { encoding: 'utf8', timeout: 3000 });
        assert.equal(negative.status, 1, negative.stdout + negative.stderr);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged');
    });
    console.log('DUAL_PRINCIPAL_NOT_VERIFIED; authorized two-UID allow + backend denial = NOT_RUN/P0');
  } finally {
    for (const p of children) p.kill('SIGKILL');
    await Promise.all([...children].map(p => p.done || once(p, 'exit')));
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  }
});
