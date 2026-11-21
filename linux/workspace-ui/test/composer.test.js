import assert from 'node:assert/strict';
import test from 'node:test';
import { composerBlockedReason, isSubmitKey, sendDisabledReason } from '../src/state/composer.js';
import { hasRunningTurn } from '../src/state/reducer.js';

test('plain Enter submits while Shift+Enter and other keys keep their native behavior', () => {
  assert.equal(isSubmitKey({ key: 'Enter' }), true);
  assert.equal(isSubmitKey({ key: 'Enter', shiftKey: true }), false);
  assert.equal(isSubmitKey({ key: 'a' }), false);
});

test('an IME confirmation does not submit', () => {
  assert.equal(isSubmitKey({ key: 'Enter', isComposing: true }), false);
  assert.equal(isSubmitKey({ key: 'Enter', isComposing: false, keyCode: 229 }), false);
});

test('only a nonblank draft can be sent when sending is enabled', () => {
  assert.equal(sendDisabledReason('', null), 'Enter a message to send.');
  assert.equal(sendDisabledReason(' \t\n ', null), 'Enter a message to send.');
  assert.equal(sendDisabledReason('Hello', 'Loading projects.'), 'Loading projects.');
  assert.equal(sendDisabledReason(' Hello ', null), null);
});

test('the composer explains each state that prevents sending', () => {
  const live = { mode: 'live', sending: false, running: false, ended: false };
  for (const [overrides, message] of [
    [{ mode: 'loading' }, 'Loading projects.'],
    [{ mode: 'error' }, 'The workspace could not load.'],
    [{ sending: true, running: true }, 'Sending…'],
    [{ running: true }, 'The agent is still working.'],
    [{ ended: true }, 'Start a new session to send.'],
  ]) assert.equal(composerBlockedReason({ ...live, ...overrides }), message);
  assert.equal(composerBlockedReason({ ...live, mode: 'mock' }), null);
});

test('connection status never blocks a ready composer', () => {
  for (const connection of ['connected', 'reconnecting', 'error']) {
    const reason = composerBlockedReason({ mode: 'live', connection });
    assert.equal(sendDisabledReason('Hello', reason), null, connection);
  }
});
test('pending prompts and running turns disable sending while the mock preview does not', () => {
  const preview = { id: 'preview', status: 'running' };
  const live = { id: 'live', status: 'running' };
  assert.equal(hasRunningTurn({ pendingPrompt: 'Hello', turns: [] }), true);
  assert.equal(hasRunningTurn({ turns: [preview] }, 'preview'), false);
  assert.equal(hasRunningTurn({ turns: [preview, live] }, 'preview'), true);
  assert.equal(hasRunningTurn({ turns: [{ ...live, status: 'success' }] }), false);
});
