import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createInputGateway } from '../input-gateway.js';

test('isolated tmux receives only the current lease holder input', async () => {
  const server = `g-${randomUUID().slice(0, 8)}`;
  const dir = mkdtempSync(path.join('/tmp', 'gw-'));
  const previous = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = dir;
  const tmux = (...args) => execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8' });
  try {
    tmux('new-session', '-d', '-s', 'workspace', '/bin/cat');
    const { broker, controller } = createInputGateway({ server, session: 'workspace' });
    const [target] = await controller.list();
    const a = broker.connect({ principal: 'writer', write: true });
    const b = broker.connect({ principal: 'owner', write: true, takeover: true });
    const watcher = broker.connect({ principal: 'watcher' });
    const lease = await broker.claim(a, target);
    await assert.rejects(broker.claim(watcher, target), /Permission/);
    await assert.rejects(broker.mutate(watcher, target, lease, { type: 'text', text: 'WATCHER' }), /Permission/);
    await broker.mutate(a, target, lease, { type: 'text', text: 'FIRST_GATEWAY' });
    await broker.mutate(a, target, lease, { type: 'key', key: 'Enter' });
    const replacement = await broker.claim(b, target, { takeover: true });
    await assert.rejects(broker.mutate(a, target, lease, { type: 'key', key: 'Enter' }), /Lease/);
    await broker.mutate(b, target, replacement, { type: 'text', text: 'SECOND_GATEWAY' });
    await broker.mutate(b, target, replacement, { type: 'key', key: 'Enter' });
    const screen = tmux('capture-pane', '-p', '-t', target.paneId);
    assert.match(screen, /FIRST_GATEWAY/); assert.match(screen, /SECOND_GATEWAY/); assert.doesNotMatch(screen, /WATCHER/);
    await broker.disconnect(b);
    await assert.rejects(broker.mutate(b, target, replacement, { type: 'text', text: 'LATE' }), /Permission/);
    tmux('kill-pane', '-t', target.paneId);
    await assert.rejects(broker.claim(a, target));
  } finally {
    try { tmux('kill-server'); } catch {}
    if (previous === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
