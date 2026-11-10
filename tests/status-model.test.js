'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { deriveStatus } = require('../linux/ui/status-model.js');

const levels = new Set(['ok', 'warn', 'error', 'unknown', 'busy']);

test('returns four complete unknown indicators for absent or invalid data', () => {
  for (const value of [undefined, null, false, 'connected', {}, { connection: 'bogus', session: 42, input: 'bogus', sharing: 'bogus' }]) {
    const result = deriveStatus(value);
    assert.deepEqual(Object.keys(result), ['connection', 'session', 'input', 'sharing']);
    for (const item of Object.values(result)) {
      assert.deepEqual(Object.keys(item), ['level', 'icon', 'label', 'detail']);
      assert.equal(item.level, 'unknown');
      assert.equal(item.label, 'Not reported');
      assert.ok(item.icon && item.detail);
    }
  }
});

test('connection states describe the connection without asserting task health', () => {
  for (const [state, level, label] of [
    ['connected', 'ok', 'Connected'],
    ['connecting', 'busy', 'Connecting'],
    ['reconnecting', 'busy', 'Reconnecting'],
    ['disconnected', 'error', 'Disconnected'],
    ['auth-expired', 'warn', 'Sign-in required']
  ]) {
    const result = deriveStatus({ connection: state });
    assert.equal(result.connection.level, level);
    assert.equal(result.connection.label, label);
    assert.equal(result.input.label, 'Not reported');
    assert.equal(result.sharing.label, 'Not reported');
    assert.equal(result.session.label, 'Not reported');
  }
  assert.match(deriveStatus({ connection: 'connected' }).connection.detail, /task health is unknown/i);
});

test('explicit authentication expiry is visible without asserting socket closure', () => {
  for (const auth of ['expired', 'auth-expired', 'auth-required']) {
    const connection = deriveStatus({ connection: 'connected', auth }).connection;
    assert.equal(connection.label, 'Sign-in required');
    assert.match(connection.detail, /may remain open/);
  }
  assert.equal(deriveStatus({ auth: 'unexpected' }).connection.level, 'unknown');
});

test('session name and process basename are observations, not health claims', () => {
  const session = deriveStatus({ session: { name: 'workspace', process: '/usr/bin/bash' } }).session;
  assert.equal(session.label, 'workspace');
  assert.equal(session.level, 'unknown');
  assert.match(session.detail, /Process: bash/);
  assert.match(session.detail, /health unknown/i);
  assert.doesNotMatch(session.detail, /\/usr\/bin/);
  assert.match(deriveStatus({ session: { process: 'C:\\Windows\\cmd.exe' } }).session.detail, /cmd\.exe/);
  assert.match(deriveStatus({ session: { name: 'workspace' } }).session.detail, /Process not reported/);
  assert.equal(deriveStatus({ session: { process: '/bin/bash --secret' } }).session.label, 'Not reported');
});

test('input is only reported when explicitly enabled or disabled', () => {
  for (const input of [true, 'enabled']) assert.equal(deriveStatus({ input }).input.label, 'Input enabled');
  for (const input of [false, 'disabled']) assert.equal(deriveStatus({ input }).input.label, 'Input disabled');
  for (const input of [null, 0, 1, {}, 'allowed', 'unknown']) {
    assert.equal(deriveStatus({ connection: 'connected', input }).input.label, 'Not reported');
  }
});

test('all backend sharing states are distinct from missing and invalid state', () => {
  for (const [state, label, level] of [
    ['sharing', 'Sharing', 'ok'],
    ['manual-paused', 'Sharing paused', 'warn'],
    ['paused', 'Sharing paused', 'warn'],
    ['owner-active', 'Owner active', 'warn'],
    ['pause-pending', 'Pausing sharing', 'busy'],
    ['unavailable', 'Sharing unavailable', 'error']
  ]) {
    for (const sharing of [state, { state }]) {
      const result = deriveStatus({ sharing }).sharing;
      assert.equal(result.label, label);
      assert.equal(result.level, level);
      assert.ok(result.icon && result.detail && levels.has(result.level));
    }
  }
  assert.match(deriveStatus({ sharing: 'manual-paused' }).sharing.detail, /manually/);
  assert.equal(deriveStatus({ sharing: { state: 'unknown' } }).sharing.label, 'Not reported');
});

test('only valid reported paused idle time produces a countdown', () => {
  for (const [idleRemainingMs, seconds] of [[0, 0], [1, 1], [1001, 2]]) {
    assert.match(deriveStatus({ sharing: { state: 'paused', idleRemainingMs } }).sharing.detail, new RegExp(`resumes in ${seconds}s`));
  }
  for (const idleRemainingMs of [undefined, null, -1, NaN, Infinity, '1000']) {
    assert.doesNotMatch(deriveStatus({ sharing: { state: 'paused', idleRemainingMs } }).sharing.detail, /resumes in/);
  }
  assert.doesNotMatch(deriveStatus({ sharing: { state: 'manual-paused', idleRemainingMs: 1000 } }).sharing.detail, /resumes in/);
});

test('browser global exposes the same dependency-free API', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../linux/ui/status-model.js'), 'utf8'), context);
  assert.equal(typeof context.TerminalStatus.deriveStatus, 'function');
  assert.equal(context.TerminalStatus.deriveStatus({ connection: 'connected' }).input.label, 'Not reported');
});
