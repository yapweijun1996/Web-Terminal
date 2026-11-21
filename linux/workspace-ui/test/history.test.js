import assert from 'node:assert/strict';
import test from 'node:test';
import { formatHistoryEntry, newestResumableEntry, relativeTime } from '../src/state/history.js';

const now = 100_000_000;
const claude = { agent: 'claude', rootId: 'root', relPath: '.', cliSessionId: 'claude-id', lastUsedAt: now - 7_200_000 };

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
    id: 'claude-id', label: 'Claude Code', detail: 'Project root · 2h ago', disabled: false, title: undefined,
  });
});

test('Codex history shows the folder with a disabled resume explanation', () => {
  assert.deepEqual(formatHistoryEntry({ ...claude, agent: 'codex', relPath: 'web/ui', cliSessionId: 'codex-id' }, now), {
    id: 'codex-id', label: 'Codex CLI', detail: 'web/ui · 2h ago', disabled: true, title: 'Resume is not verified for Codex yet',
  });
});

test('resume finds the newest matching Claude CLI ID regardless of history order', () => {
  const newest = { ...claude, cliSessionId: 'latest-id', lastUsedAt: now - 10_000 };
  const otherRoot = { ...claude, rootId: 'other', lastUsedAt: now };
  const otherFolder = { ...claude, relPath: 'web', lastUsedAt: now };
  const codex = { ...claude, agent: 'codex', lastUsedAt: now };
  const entries = [claude, otherRoot, otherFolder, codex, newest];
  assert.equal(newestResumableEntry(entries, claude), newest);
  assert.equal(newestResumableEntry(entries, otherFolder), otherFolder);
  assert.equal(newestResumableEntry(entries, { ...claude, relPath: 'missing' }), undefined);
  assert.equal(newestResumableEntry(entries, codex), undefined);
});
