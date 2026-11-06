'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startProductionGateway, inspectResources } = require('../release-gate/production-adapter');
test('Golden: production startup refuses direct backend, same UID, missing G0, forged metadata and ACL', async () => {
  const root = fs.mkdtempSync('/private/tmp/mba-release-gateway-');
  const before = fs.readdirSync(root); let writes = 0, listeners = 0;
  const originalNet = net.Server.prototype.listen, originalHttp = http.Server.prototype.listen;
  net.Server.prototype.listen = http.Server.prototype.listen = function () { listeners++; throw Error('listener forbidden'); };
  try {
    for (const options of [
      {}, { backend: { execute() { writes++; } } },
      { supervisorUid: process.geteuid(), clientUid: process.geteuid() },
      { supervisorUid: 4000000000, clientUid: process.geteuid() },
      { G0: 'PASS', acl: 'PASS', peercred: { uid: 4000000000 }, independentlyVerified: true, token: 'fake.jwt.signature', execute() { writes++; } },
      { backend: Object.create({ execute() { writes++; } }), G0: 'PASS' },
      { nativeProbe: () => ({ productionAuthorization: true }), attestation: { verified: true } }
    ]) await assert.rejects(startProductionGateway({ ...options, socketPath: path.join(root, 'production.sock') }), e => e.code === 'RELEASE_BLOCKED');
    const hostile = new Proxy({}, { get() { throw Error('must not evaluate attacker callbacks or approval getters'); } });
    await assert.rejects(startProductionGateway(hostile), e => e.code === 'RELEASE_BLOCKED');
    const cli = spawnSync(process.execPath, ['release-gate/production-adapter.js'], { encoding: 'utf8', env: { ...process.env, G0: 'PASS', ALLOW_SAME_UID: '1', APPROVED: 'true', NATIVE_ACL: 'PASS' } });
    assert.equal(cli.status, 1); assert.match(cli.stderr, /P0 RELEASE BLOCKED/);
    assert.equal(writes, 0); assert.equal(listeners, 0); assert.deepEqual(fs.readdirSync(root), before);
    await assert.rejects(new Promise((resolve, reject) => { const c = net.createConnection(path.join(root, 'production.sock')); c.on('connect', () => { c.destroy(); resolve(); }); c.on('error', reject); }), /ENOENT/);
  } finally { net.Server.prototype.listen = originalNet; http.Server.prototype.listen = originalHttp; fs.rmSync(root, { recursive: true, force: true }); }
});
test('Golden: real native probe observes replacement/drift; never grants command or starts transport', async () => {
  const root = fs.mkdtempSync('/private/tmp/mba-release-e2e-');
  try {
    const bin = path.join(root, 'inspect');
    const b = spawnSync('/usr/bin/clang', ['-Wall', '-Wextra', '-Werror', 'release-gate/native-acl.c', '-o', bin], { encoding: 'utf8' });
    assert.equal(b.status, 0, b.stderr);
    const dirs = Object.fromEntries(['backend', 'ingress-dir', 'socket'].map(r => { const d = path.join(root, r); fs.mkdirSync(d, { mode: 0o700 }); return [r, d]; }));
    const config = { binary: bin, supervisorUid: process.geteuid(), clientUid: 4000000000, paths: dirs };
    const a = inspectResources(config);
    assert.equal(a.productionAuthorization, false); assert.equal(a.observations.backend.reason, 'BACKEND_PRIVATE_METADATA');
    assert.equal(a.observations['ingress-dir'].reason, 'MISSING_ACL');
    fs.renameSync(dirs.backend, dirs.backend + '-old'); fs.mkdirSync(dirs.backend, { mode: 0o700 });
    const drift = inspectResources({ ...config, pins: { backend: a.observations.backend.pin } });
    assert.equal(drift.observations.backend.reason, 'PATH_RACE');
    const disconnected = inspectResources({ ...config, paths: { ...dirs, socket: path.join(root, 'disconnected.sock') } });
    assert.equal(disconnected.observations.socket.reason, 'STAT_UNAVAILABLE');
    assert.equal(disconnected.productionAuthorization, false);
    const noProbe = inspectResources({ ...config, binary: bin + '-missing' });
    assert.ok(Object.values(noProbe.observations).every(v => v.reason === 'PROBE_UNAVAILABLE'));
    await assert.rejects(startProductionGateway({ ...config, G0: 'PASS', observations: a }), e => e.code === 'RELEASE_BLOCKED');
    assert.equal(fs.existsSync(path.join(root, 'production.sock')), false);
    console.log('SCRATCH_E2E=DENIED; ACL_DRIFT_POSITIVE_FIXTURE=NOT_RUN; signed Writer positive: run original collaboration-gateway Golden (SAME_UID only)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
