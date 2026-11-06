'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { generateKeyPairSync, sign, randomUUID } = require('node:crypto');
const BACKEND = 21001, GATEWAY = 21002, SHARED = 22000;
const worker = path.join(__dirname, 'worker.js');
const env = { PATH: process.env.PATH, HOME: '/tmp', TERM: 'xterm', LANG: 'C.UTF-8' };
let checks = 0;
function pass(name, detail) { checks++; console.log(`PASS ${checks} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`); }
function run(command, args, uid = BACKEND, gid = BACKEND, input) {
  const p = spawnSync(command, args, { uid, gid, env, input, encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 });
  if (p.error || p.status !== 0) throw Error(`${command} failed: ${p.error || p.status} ${p.stderr}`);
  return p.stdout.trim();
}
function call(mode, config, uid = GATEWAY) { return JSON.parse(run(process.execPath, [worker, mode], uid, uid === GATEWAY ? SHARED : BACKEND, JSON.stringify(config))); }
async function until(fn, label) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)); }
  throw Error('TIMEOUT: ' + label);
}
async function main() {
  assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 0);
  assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\s+(\d+)/m)[1], '1');
  assert.throws(() => fs.writeFileSync('/isolation-write-probe', 'x'), e => e.code === 'EROFS');
  pass('Linux root orchestrator; no-new-privileges; root filesystem read-only');
  const version = run('tmux', ['-V']); assert.match(version, /^tmux 3\./); pass('real tmux 3.x', version);
  const dir = fs.mkdtempSync('/tmp/isolation-');
  const privateDir = path.join(dir, 'private'), sharedDir = path.join(dir, 'supervisor');
  const tmuxSocket = path.join(privateDir, 'tmux.sock'), ttydSocket = path.join(privateDir, 'ttyd.sock');
  const fakeSockets = ['upload.sock', 'mcp.sock'].map(n => path.join(privateDir, n));
  const supervisorSocket = path.join(sharedDir, 'control.sock');
  const children = [];
  let tmuxStarted = false;
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    try { await until(() => child.exitCode !== null || child.signalCode !== null, 'owned child exit'); }
    catch { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 'owned child kill'); }
  };
  const deadline = setTimeout(() => { console.error('FAIL overall timeout'); process.exit(1); }, 55000);
  try {
    fs.chmodSync(dir, 0o755);
    fs.mkdirSync(privateDir, { mode: 0o700 }); fs.chownSync(privateDir, BACKEND, BACKEND);
    fs.mkdirSync(sharedDir, { mode: 0o710 }); fs.chownSync(sharedDir, BACKEND, SHARED);
    const tmux = args => run('tmux', ['-S', tmuxSocket, ...args]);
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', '/bin/cat']); tmuxStarted = true;
    const pane = tmux(['display-message', '-p', '-t', 'fixture:0.0', '#{pane_id}']);
    tmux(['new-window', '-d', '-t', 'fixture', '/bin/cat']);
    const alternate = tmux(['display-message', '-p', '-t', 'fixture:1.0', '#{pane_id}']); assert.notEqual(pane, alternate);
    const capture = target => tmux(['capture-pane', '-p', '-t', target]);
    const catPid = Number(tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']));
    assert.match(fs.readFileSync(`/proc/${catPid}/status`, 'utf8'), /^Uid:\s+21001\s+21001\s+21001\s+21001$/m);
    tmux(['send-keys', '-t', pane, '-l', '--', 'BACKEND_POSITIVE']); tmux(['send-keys', '-t', pane, 'Enter']);
    await until(() => capture(pane).split('BACKEND_POSITIVE').length >= 3, 'cat echo and output');
    pass('backend-owned live tmux + real cat positive send/capture', { pane, alternate, catUid: BACKEND });
    const keys = generateKeyPairSync('ed25519');
    const config = { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), pane, lease: randomUUID(), epoch: randomUUID(), tmuxSocket, supervisorSocket, fakeSockets };
    let serverOutput = '', serverError = '';
    const server = spawn(process.execPath, [worker, 'serve'], { uid: BACKEND, gid: BACKEND, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(server);
    server.on('error', e => { serverError += e.message; }); server.stdout.on('data', b => { serverOutput += b; }); server.stderr.on('data', b => { serverError += b; }); server.stdin.end(JSON.stringify(config));
    await until(() => { if (server.exitCode !== null) throw Error(serverError); return serverOutput.includes('\n'); }, 'supervisor ready');
    const backendIdentity = JSON.parse(serverOutput.trim()); assert.equal(backendIdentity.uid, BACKEND); assert.equal(BigInt('0x' + backendIdentity.capEff), 0n);
    fs.chownSync(supervisorSocket, BACKEND, SHARED); fs.chmodSync(supervisorSocket, 0o660);
    let ttydError = '';
    const ttyd = spawn('ttyd', ['-i', ttydSocket, 'tmux', '-S', tmuxSocket, 'attach-session', '-r', '-t', 'fixture'], { uid: BACKEND, gid: BACKEND, env, stdio: ['ignore', 'ignore', 'pipe'] }); children.push(ttyd);
    ttyd.on('error', e => { ttydError += e.message; }); ttyd.stderr.on('data', b => { ttydError += b; });
    await until(() => { if (ttyd.exitCode !== null) throw Error(ttydError); return fs.existsSync(ttydSocket); }, 'real readonly ttyd socket');
    const gatewayIdentity = call('identity', {}); assert.equal(gatewayIdentity.uid, GATEWAY); assert.equal(BigInt('0x' + gatewayIdentity.capEff), 0n); assert.equal(gatewayIdentity.gid, SHARED); assert.ok(!gatewayIdentity.groups.includes(BACKEND));
    pass('distinct real process getuid values', { backend: backendIdentity, gateway: gatewayIdentity });
    for (const [p, uid, gid, mode] of [[privateDir, BACKEND, BACKEND, 0o700], [sharedDir, BACKEND, SHARED, 0o710], [supervisorSocket, BACKEND, SHARED, 0o660]]) {
      const s = fs.statSync(p); assert.equal(s.uid, uid); assert.equal(s.gid, gid); assert.equal(s.mode & 0o777, mode);
      pass('stat ownership/mode', { path: p, uid: s.uid, gid: s.gid, mode: (s.mode & 0o777).toString(8) });
    }
    assert.ok(['EACCES', 'EPERM'].includes(call('traverse', { path: privateDir }).error)); pass('gateway cannot traverse private directory');
    for (const p of [tmuxSocket, ttydSocket, ...fakeSockets]) {
      const stat = fs.statSync(p); assert.ok(stat.isSocket()); assert.equal(stat.uid, BACKEND);
      const positive = call('probe', { path: p }, BACKEND); assert.equal(positive.ok, true, JSON.stringify(positive));
      const denied = call('probe', { path: p }); assert.ok(['EACCES', 'EPERM'].includes(denied.error), JSON.stringify(denied));
      pass('live socket backend positive + gateway kernel denial', { socket: path.basename(p), errno: denied.error, uid: stat.uid, mode: (stat.mode & 0o777).toString(8) });
    }
    const issue = (patch = {}, privateKey = keys.privateKey) => {
      const time = Date.now(); const claims = { iss: 'test-issuer', aud: 'supervisor', role: 'writer', pane, lease: config.lease, epoch: config.epoch, iat: time, exp: time + 4000, nonce: randomUUID(), op: 'text', text: 'FORBIDDEN', ...patch };
      if (claims.op !== 'text') delete claims.text;
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return { payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64url') };
    };
    const request = (envelope, uid = GATEWAY) => {
      const result = call('request', { path: supervisorSocket, request: envelope }, uid); assert.equal(result.ok, true, JSON.stringify(result)); return result.response;
    };
    const reject = (name, envelope, uid) => { assert.deepEqual(request(envelope, uid), { ok: false, error: 'DENIED' }); pass(name); };
    reject('reachable supervisor denies unauthenticated forged role/uid', { role: 'writer', uid: BACKEND, op: 'text', text: 'FORBIDDEN' });
    reject('wrong signing key', issue({}, generateKeyPairSync('ed25519').privateKey));
    for (const [name, patch] of [ ['Watcher', { role: 'watcher' }], ['alternate pane', { pane: alternate }], ['old lease', { lease: 'old' }], ['old epoch', { epoch: 'old' }], ['expired', { iat: Date.now() - 4000, exp: Date.now() - 1 }], ['future', { iat: Date.now() + 2000, exp: Date.now() + 4000 }], ['overlong lifetime', { exp: Date.now() + 60000 }], ['unknown operation', { op: 'unknown' }], ['shell', { op: 'shell' }], ['resize', { op: 'resize' }], ['raw tmux', { op: 'tmux' }], ['control characters', { text: '\nFORBIDDEN' }], ['extra asserted uid', { uid: BACKEND }], ['invalid key', { op: 'key', key: 'C-c' }]]) reject(name, issue(patch));
    reject('trusted backend UID also denied signed alternate pane', issue({ pane: alternate }), BACKEND);
    const accepted = issue({ text: 'WRITER_ALLOWED' }); assert.deepEqual(request(accepted), { ok: true }); pass('gateway Writer signed literal accepted');
    reject('one-use nonce replay', accepted);
    assert.deepEqual(request(issue({ op: 'key', key: 'Enter' })), { ok: true });
    await until(() => capture(pane).split('WRITER_ALLOWED').length >= 3, 'supervised cat output'); pass('signed Enter and real cat output');
    assert.doesNotMatch(capture(pane), /FORBIDDEN/); assert.doesNotMatch(capture(alternate), /WRITER_ALLOWED|FORBIDDEN/); pass('rejections caused no forbidden/alternate output');
    assert.deepEqual(request(issue({ op: 'release' })), { ok: true });
    reject('released lease', issue());
    reject('backend UID cannot revive released lease', issue(), BACKEND);
    pass('candidate assertions complete; P0 RELEASE BLOCKED');
  } catch (e) { console.error('PRIMARY FAILURE', e.stack); throw e; } finally {
    for (const child of children.reverse()) await stop(child);
    if (tmuxStarted) run('tmux', ['-S', tmuxSocket, 'kill-server']);
    fs.rmSync(dir, { recursive: true, force: true }); assert.equal(fs.existsSync(dir), false);
    clearTimeout(deadline); pass('owned fixture processes stopped; temp directory removed');
  }
  console.log(`RESULT PASS ${checks} checks; P0 RELEASE BLOCKED`);
}
main().catch(e => { console.error('RESULT FAIL', e.stack); process.exitCode = 1; });
