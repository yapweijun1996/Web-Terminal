import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceClient } from '../src/api/client.js';

test('GET projects does not request or send the mutation token', async () => {
  const data = { projects: [{ id: 'root', label: 'Example', folders: [] }] };
  const client = createWorkspaceClient(async (url, options) => {
    assert.equal(url, '/api/workspace/projects');
    assert.equal(options.method, undefined);
    assert.equal(options.headers, undefined);
    return Response.json(data);
  });
  assert.deepEqual(await client.listProjects(), data);
});

test('every POST loads the token and sends the expected headers and body', async () => {
  const calls = [];
  const client = createWorkspaceClient(async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/sessions') return Response.json({ token: 'fixture-token' });
    if (url.endsWith('/sessions')) return Response.json({ sessionId: 'new-id' }, { status: 201 });
    return Response.json({ ok: true });
  });

  assert.equal(await client.startSession({ rootId: 'root', agent: 'codex', resumeSessionId: 'old-id' }), 'new-id');
  await client.sendMessage('new-id', 'Hello');
  await client.stop('new-id');
  await client.decideApproval('new-id', 'approval-1', 'deny');
  const expected = [
    ['/api/workspace/sessions', { rootId: 'root', relPath: '.', agent: 'codex', resumeSessionId: 'old-id' }],
    ['/api/workspace/sessions/new-id/messages', { text: 'Hello' }],
    ['/api/workspace/sessions/new-id/stop', {}],
    ['/api/workspace/sessions/new-id/approvals/approval-1', { decision: 'deny' }],
  ];
  assert.equal(calls.length, expected.length * 2);
  expected.forEach(([url, body], index) => {
    assert.equal(calls[index * 2][0], '/api/sessions');
    const [postUrl, options] = calls[index * 2 + 1];
    assert.equal(postUrl, url);
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', 'X-Terminal-Request': 'fixture-token' });
    assert.deepEqual(JSON.parse(options.body), body);
  });
  assert.equal(client.displayText('fixture-token at /srv/workspace'), '[redacted] at [path]');
});

test('server error codes map to readable messages and retain HTTP status', async () => {
  const client = createWorkspaceClient(async (url) => url === '/api/sessions'
    ? Response.json({ token: 'fixture-token' })
    : Response.json({ error: 'turn_active' }, { status: 409 }));
  await assert.rejects(client.sendMessage('session', 'Hello'), {
    code: 'turn_active', status: 409, message: 'Wait for the current turn to finish or stop it first.',
  });
});

test('a missing projects route keeps its 404 status even with a non-JSON body', async () => {
  const client = createWorkspaceClient(async () => new Response('Not found', { status: 404 }));
  await assert.rejects(client.listProjects(), { code: 'not_found', status: 404 });
});

test('a missing token prevents the mutation', async () => {
  const urls = [];
  const client = createWorkspaceClient(async (url) => {
    urls.push(url);
    return Response.json({});
  });
  await assert.rejects(client.stop('session'), { code: 'invalid_response' });
  assert.deepEqual(urls, ['/api/sessions']);
});
