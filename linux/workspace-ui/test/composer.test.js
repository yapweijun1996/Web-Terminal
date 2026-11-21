import assert from 'node:assert/strict';
import test from 'node:test';
import { canSendMessage, isSubmitKey } from '../src/state/composer.js';
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
  assert.equal(canSendMessage('', false), false);
  assert.equal(canSendMessage(' \t\n ', false), false);
  assert.equal(canSendMessage('Hello', true), false);
  assert.equal(canSendMessage(' Hello ', false), true);
});

test('pending prompts and running turns disable sending while the mock preview does not', () => {
  const preview = { id: 'preview', status: 'running' };
  const live = { id: 'live', status: 'running' };
  assert.equal(hasRunningTurn({ pendingPrompt: 'Hello', turns: [] }), true);
  assert.equal(hasRunningTurn({ turns: [preview] }, 'preview'), false);
  assert.equal(hasRunningTurn({ turns: [preview, live] }, 'preview'), true);
  assert.equal(hasRunningTurn({ turns: [{ ...live, status: 'success' }] }), false);
});
