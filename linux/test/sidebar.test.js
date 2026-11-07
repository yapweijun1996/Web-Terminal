'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { clampWidth, readPrefs, writePrefs, orderSessions, sessionStatus } = require('../ui/sidebar');

function storageWith(value) {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key, next) => { stored = next; },
  };
}

const defaults = () => ({ width: 240, theme: 'dark', pins: [], collapsed: { Pinned: false, Sessions: false } });

test('sidebar width defaults for invalid values and clamps to its supported range', () => {
  for (const value of [undefined, null, '', '260', NaN, Infinity, -Infinity, {}, []]) {
    assert.equal(clampWidth(value), 240);
  }
  assert.equal(clampWidth(199), 200);
  assert.equal(clampWidth(-100), 200);
  assert.equal(clampWidth(321), 320);
  assert.equal(clampWidth(1000), 320);
  for (const value of [200, 240, 277.5, 320]) assert.equal(clampWidth(value), value);
});

test('pin ordering is stable, independent of pin list order and does not mutate sessions', () => {
  const sessions = ['shared', 'web-first', 'web-second', 'web-third'];
  const pins = ['web-third', 'web-first', 'missing', 'web-first'];
  assert.deepEqual(orderSessions(sessions, pins, id => id), ['web-first', 'web-third', 'shared', 'web-second']);
  assert.deepEqual(sessions, ['shared', 'web-first', 'web-second', 'web-third']);
  assert.deepEqual(pins, ['web-third', 'web-first', 'missing', 'web-first']);
  assert.deepEqual(orderSessions(sessions, [], id => id), sessions);
});

test('search filters display labels case-insensitively before returning pinned-first results', () => {
  const sessions = ['shared', 'web-first', 'web-second', 'web-third'];
  const names = { shared: 'Existing terminal', 'web-first': 'Build API', 'web-second': 'BUILD UI', 'web-third': 'Editor' };
  const label = id => names[id];
  assert.deepEqual(orderSessions(sessions, ['web-second', 'web-third'], label, ' bUiLd '), ['web-second', 'web-first']);
  assert.deepEqual(orderSessions(sessions, ['web-third'], label, 'web-first'), []);
  assert.deepEqual(orderSessions(sessions, [], label, 'not found'), []);
  assert.deepEqual(orderSessions(sessions, [], label, '  '), sessions);
  assert.deepEqual(orderSessions([], ['shared'], label, 'build'), []);
});

test('a missing session or non-connected view is disconnected regardless of its command', () => {
  for (const connection of ['Connecting', 'Disconnected', 'Connection error', '', undefined]) {
    assert.deepEqual(sessionStatus(true, connection, '/usr/bin/bash'), { state: 'Disconnected', command: 'bash' });
  }
  assert.deepEqual(sessionStatus(false, 'Connected', '/usr/bin/vim'), { state: 'Disconnected', command: 'vim' });
});

test('connected shells are idle and other foreground commands are running', () => {
  for (const command of ['bash', 'zsh', 'sh', 'fish', 'dash']) {
    assert.deepEqual(sessionStatus(true, 'Connected', `/bin/${command}`), { state: 'Idle', command });
  }
  for (const command of ['vim', 'node', 'python3', 'htop', 'bash-script']) {
    assert.deepEqual(sessionStatus(true, 'Connected', command), { state: 'Running', command });
  }
  assert.deepEqual(sessionStatus(true, 'Connected', undefined), { state: 'Running', command: '' });
});

test('status exposes only a sanitized basename bounded to 24 characters', () => {
  assert.deepEqual(sessionStatus(true, 'Connected', '/some/private/path/my-command'), { state: 'Running', command: 'my-command' });
  assert.equal(sessionStatus(true, 'Connected', '/bin/my\x1b\n\t<command>').command, 'mycommand');
  assert.equal(sessionStatus(true, 'Connected', '/bin/' + 'a'.repeat(40)).command, 'a'.repeat(24));
  assert.equal(sessionStatus(true, 'Connected', '/bin/node\u202eexe').command, 'nodeexe');
  assert.equal(sessionStatus(true, 'Connected', '/bin/foo@bar').command, 'foobar');
  assert.equal(sessionStatus(true, 'Connected', '/bin/tool-name_v2.0+debug').command, 'tool-name_v2.0+debug');
  for (const command of [null, 1, {}, []]) assert.equal(sessionStatus(true, 'Connected', command).command, '');
});

test('missing, malformed and non-object stored preferences produce fresh defaults', () => {
  for (const value of [null, '', '{', 'null', '42', 'false', '[]', '"dark"']) {
    assert.deepEqual(readPrefs(storageWith(value)), defaults());
  }
  const first = readPrefs(storageWith(null));
  first.pins.push('shared');
  first.collapsed.Pinned = true;
  assert.deepEqual(readPrefs(storageWith(null)), defaults());
});

test('stored preferences validate each field without discarding independent valid choices', () => {
  const storage = storageWith(JSON.stringify({
    width: 999, theme: 'system', pins: ['shared', 2, null, 'web-one', 'shared'],
    collapsed: { Pinned: true, Sessions: 'true', Other: true }, unknown: 'discard',
  }));
  assert.deepEqual(readPrefs(storage), {
    width: 320, theme: 'system', pins: ['shared', 'web-one'], collapsed: { Pinned: true, Sessions: false },
  });
  assert.deepEqual(readPrefs(storageWith(JSON.stringify({ width: '270', theme: 'blue', pins: {}, collapsed: null }))), defaults());
  assert.deepEqual(readPrefs(storageWith(JSON.stringify({ width: 100, theme: 'light', collapsed: { Sessions: true } }))), {
    width: 200, theme: 'light', pins: [], collapsed: { Pinned: false, Sessions: true },
  });
});

test('writing preferences round-trips only validated supported fields', () => {
  const storage = storageWith(null);
  const prefs = { width: 288, theme: 'light', pins: ['shared', 'web-one'], collapsed: { Pinned: true, Sessions: true } };
  assert.equal(writePrefs(storage, { ...prefs, unrelated: 'not persisted' }), true);
  assert.deepEqual(readPrefs(storage), prefs);
  assert.deepEqual(JSON.parse(storage.getItem()), prefs);
  assert.equal(writePrefs(storage, { width: -10, theme: 'invalid', pins: [false, 'shared'], collapsed: { Pinned: 1 } }), true);
  assert.deepEqual(readPrefs(storage), { width: 200, theme: 'dark', pins: ['shared'], collapsed: { Pinned: false, Sessions: false } });
});

test('unavailable and denied storage never escape the preference boundary', () => {
  const denied = {
    getItem() { throw Error('Storage denied'); },
    setItem() { throw Error('Storage denied'); },
  };
  assert.deepEqual(readPrefs(denied), defaults());
  assert.equal(writePrefs(denied, defaults()), false);
  assert.deepEqual(readPrefs(undefined), defaults());
  assert.equal(writePrefs(undefined, defaults()), false);
  assert.equal(writePrefs({ setItem() { throw Error('Quota exceeded'); } }, defaults()), false);
});
