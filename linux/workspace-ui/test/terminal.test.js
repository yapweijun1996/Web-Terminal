import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalId, terminalReducer } from '../src/state/terminal.js';

const idle = { status: 'idle' };
const validId = 'web-012345abcdef';

test('terminal IDs require the exact lowercase web session format', () => {
  assert.equal(isTerminalId(validId), true);
  for (const id of [
    null, undefined, [validId], 'WEB-012345abcdef', 'web-012345abcde', 'web-012345abcdefg',
    'web-012345abcdeF', '/terminal/web-012345abcdef/', validId + '\n',
  ]) {
    assert.equal(isTerminalId(id), false, String(id));
  }
});

test('opening requests a terminal once and reopening retains the same frame', () => {
  const loading = terminalReducer(idle, { type: 'open' });
  assert.deepEqual(loading, { status: 'loading' });
  assert.equal(terminalReducer(loading, { type: 'open' }), loading);
  const ready = terminalReducer(loading, { type: 'created', terminalId: validId });
  assert.deepEqual(ready, { status: 'ready', url: `/terminal/${validId}/` });
  assert.equal(terminalReducer(ready, { type: 'open' }), ready);
  assert.equal(terminalReducer(ready, { type: 'failed', error: { status: 404 } }), ready);
});

test('a disabled terminal stays disabled and other failures permit an explicit retry', () => {
  const loading = terminalReducer(idle, { type: 'open' });
  const disabled = terminalReducer(loading, { type: 'failed', error: { status: 404 } });
  assert.deepEqual(disabled, { status: 'disabled' });
  assert.equal(terminalReducer(disabled, { type: 'open' }), disabled);
  assert.equal(terminalReducer(disabled, { type: 'retry' }), disabled);
  const error = terminalReducer(loading, { type: 'failed', error: new Error('Could not reach the workspace server.') });
  assert.deepEqual(error, { status: 'error', message: 'Could not reach the workspace server.' });
  assert.equal(terminalReducer(error, { type: 'open' }), error);
  assert.deepEqual(terminalReducer(error, { type: 'retry' }), loading);
});

test('an idle terminal ignores results and an invalid response never produces a frame URL', () => {
  assert.equal(terminalReducer(idle, { type: 'created', terminalId: validId }), idle);
  const loading = terminalReducer(idle, { type: 'open' });
  const invalid = terminalReducer(loading, { type: 'created', terminalId: 'web-012345abcdef#fragment' });
  assert.deepEqual(invalid, { status: 'error', message: 'The workspace server returned an unexpected response.' });
});
