import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readModelChoices, resolveModelChoice, sessionNeedsNewChoice, writeModelChoices,
} from '../src/state/options.js';

const options = {
  default: 'sonnet',
  defaultEffort: 'medium',
  models: [
    { id: 'opus', label: 'Opus', efforts: ['high', 'max'] },
    { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', label: 'Haiku', efforts: [] },
  ],
};

test('choices use the server defaults unless a supported preference exists', () => {
  assert.deepEqual(resolveModelChoice(options), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(resolveModelChoice(options, { model: 'unknown', effort: 'max' }), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(resolveModelChoice(options, { model: 'opus', effort: 'max' }), { model: 'opus', effort: 'max' });
  assert.equal(resolveModelChoice(undefined), undefined);
});

test('switching models preserves a supported effort or falls back to a valid effort', () => {
  assert.deepEqual(resolveModelChoice(options, { model: 'opus', effort: 'medium' }), { model: 'opus', effort: 'high' });
  assert.deepEqual(resolveModelChoice(options, { model: 'sonnet', effort: 'high' }), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(resolveModelChoice(options, { model: 'sonnet', effort: 'max' }), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(resolveModelChoice(options, { model: 'haiku', effort: 'low' }), { model: 'haiku', effort: undefined });
});

test('only changing an existing session model or effort requires another workspace session', () => {
  const session = { model: 'sonnet', effort: 'medium' };
  assert.equal(sessionNeedsNewChoice(null, session), false);
  assert.equal(sessionNeedsNewChoice(session, undefined), false);
  assert.equal(sessionNeedsNewChoice(session, { ...session }), false);
  assert.equal(sessionNeedsNewChoice(session, { ...session, effort: 'low' }), true);
  assert.equal(sessionNeedsNewChoice(session, { ...session, model: 'opus' }), true);
});

test('model preferences round-trip independently per agent through injected storage', () => {
  const values = new Map();
  const storage = () => ({ getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) });
  const choices = { claude: { model: 'sonnet', effort: 'low' }, codex: { model: 'gpt-6.2-sol', effort: 'medium' } };
  writeModelChoices(choices, storage);
  assert.deepEqual(readModelChoices(storage), choices);
});

test('invalid data and unavailable browser storage are harmless', () => {
  for (const raw of ['{', 'null', '[]']) {
    assert.deepEqual(readModelChoices(() => ({ getItem: () => raw })), {});
  }
  const denied = () => { throw new Error('Access denied'); };
  assert.deepEqual(readModelChoices(denied), {});
  assert.doesNotThrow(() => writeModelChoices({}, denied));
  assert.doesNotThrow(() => writeModelChoices({}, () => ({
    setItem() { throw new Error('Storage quota exceeded'); },
  })));
});
