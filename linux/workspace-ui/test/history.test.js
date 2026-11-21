import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHistoryEntry, newestResumableEntry, relativeTime, startWithResumeFallback } from '../src/state/history.js';

const now = 100_000_000;
const claude = { agent: 'claude', rootId: 'root', relPath: '.', cliSessionId: 'claude-id', lastUsedAt: now - 7_200_000 };
const codex = { ...claude, agent: 'codex', cliSessionId: 'codex-id' };

test('relative time uses compact units and handles clock skew', () => {
  assert.equal(relativeTime(now + 5_000, now), 'Just now');
  assert.equal(relativeTime(now - 59_999, now), 'Just now');
  assert.equal(relativeTime(now - 60_000, now), '1m ago');
  assert.equal(relativeTime(now - 3_599_999, now), '59m ago');
  assert.equal(relativeTime(now - 7_200_000, now), '2h ago');
  assert.equal(relativeTime(now - 86_400_000, now), '1d ago');
});

test('Claude history shows the agent, project root and relative age', () => {
  assert.deepEqual(formatHistoryEntry(claude, now), {
    id: 'claude-id', label: 'Claude Code', detail: 'Project root · 2h ago', modelDetail: '',
  });
});

test('Codex history shows the agent, folder and relative age', () => {
  assert.deepEqual(formatHistoryEntry({ ...codex, relPath: 'web/ui', model: 'gpt-6.2-sol', effort: 'medium' }, now), {
    id: 'codex-id', label: 'Codex CLI', detail: 'web/ui · 2h ago', modelDetail: 'gpt-6.2-sol · medium',
  });
});

test('resume finds the newest matching Claude CLI ID regardless of history order', () => {
  const newest = { ...claude, cliSessionId: 'latest-id', lastUsedAt: now - 10_000 };
  const otherRoot = { ...claude, rootId: 'other', lastUsedAt: now };
  const otherFolder = { ...claude, relPath: 'web', lastUsedAt: now };
  const newerCodex = { ...codex, lastUsedAt: now };
  const entries = [claude, otherRoot, otherFolder, newerCodex, newest];
  assert.equal(newestResumableEntry(entries, claude), newest);
  assert.equal(newestResumableEntry(entries, otherFolder), otherFolder);
  assert.equal(newestResumableEntry(entries, { ...claude, relPath: 'missing' }), undefined);
});

test('resume finds the newest Codex CLI ID for the selected project and folder', () => {
  const newest = { ...codex, cliSessionId: 'latest-codex-id', lastUsedAt: now - 10_000 };
  const otherRoot = { ...codex, rootId: 'other', lastUsedAt: now };
  const otherFolder = { ...codex, relPath: 'web', lastUsedAt: now };
  const newerClaude = { ...claude, lastUsedAt: now };
  const entries = [newest, otherRoot, otherFolder, newerClaude, codex];
  assert.equal(newestResumableEntry(entries, codex), newest);
  assert.equal(newestResumableEntry(entries, otherFolder), otherFolder);
  assert.equal(newestResumableEntry(entries, { ...codex, relPath: 'missing' }), undefined);
});

test('model-aware resume only considers history with the selected model', () => {
  const saved = { ...claude, model: 'sonnet', effort: 'low' };
  const unknown = { ...claude, lastUsedAt: now };
  const different = { ...claude, model: 'opus', lastUsedAt: now };
  assert.equal(newestResumableEntry([unknown, saved, different], { ...claude, model: 'sonnet' }), saved);
  assert.equal(newestResumableEntry([unknown], { ...claude, model: 'sonnet' }), undefined);
});

test('restart recovery uses the chosen CLI ID and starts fresh when no ID is chosen', async () => {
  const start = async (cliSessionId) => cliSessionId ?? 'fresh';
  assert.equal(await startWithResumeFallback(start, 'known-id'), 'known-id');
  assert.equal(await startWithResumeFallback(start), 'fresh');
});

test('restart recovery tries a fresh session only once when resuming is unavailable', async () => {
  const unavailable = { status: 409, code: 'resume_unavailable' };
  const calls = [];
  await assert.rejects(startWithResumeFallback(async (cliSessionId) => {
    calls.push(cliSessionId);
    throw unavailable;
  }, 'known-id'), unavailable);
  assert.deepEqual(calls, ['known-id', undefined]);
});

test('restart recovery leaves other conflicts to the caller', async () => {
  const active = { status: 409, code: 'turn_active' };
  const calls = [];
  await assert.rejects(startWithResumeFallback(async (cliSessionId) => {
    calls.push(cliSessionId);
    throw active;
  }, 'known-id'), active);
  assert.deepEqual(calls, ['known-id']);
});
