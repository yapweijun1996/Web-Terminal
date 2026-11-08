'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
for (const mode of ['missing-dependency', 'transport-init-failure']) test(`coordinated startup ${mode} exits nonzero and leaves no accepting authority`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-start-'));
  try {
    const preload = path.join(root, 'preload.cjs');
    fs.writeFileSync(preload, `const Module=require('node:module');const load=Module._load;Module._load=function(name,...args){if(name==='./collaboration-websocket'){${mode === 'missing-dependency' ? "throw Error('test missing ws dependency')" : "return{createManagedWebSockets(){throw Error('test transport initialization failure')}}"};}return load.call(this,name,...args)};`);
    const socket = path.join(root, 'c.sock');
    const child = spawnSync(process.execPath, ['--require', preload, path.resolve(__dirname, '../ui/server.js')], { timeout: 5000, encoding: 'utf8', env: {
      ...process.env, TERMINAL_RUNTIME: root, TERMINAL_COLLABORATION_SOCKET: socket, TERMINAL_OWNER_VERIFY_SOCKET: path.join(root, 'unused-owner.sock'), TERMINAL_OWNER_VERIFY_URL: 'https://fixture.invalid/approve', TERMINAL_GRANT_VERIFY_SOCKET: path.join(root, 'unused-grant.sock'), TERMINAL_TMUX_SOCKET: 'startup-unused',
    } });
    assert.equal(child.status, 1, child.error?.message || 'process must terminate after partial failure');
    assert.match(child.stderr, /Collaboration configuration unavailable/);
    assert.equal(fs.existsSync(socket), false, 'coordinator socket must not survive startup failure');
    assert.equal(fs.existsSync(path.join(root, 'ui.sock')), false, 'owner UI must not accept partial startup');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
