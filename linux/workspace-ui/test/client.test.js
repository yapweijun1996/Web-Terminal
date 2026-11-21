import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceClient, isMissingSession } from '../src/api/client.js';

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

test('GET history requests all agents without a mutation token', async () => {
  const data = { entries: [{
    agent: 'claude', rootId: 'root', relPath: 'web', cliSessionId: 'old-id', lastUsedAt: 100,
  }] };
  const client = createWorkspaceClient(async (url, options) => {
    assert.equal(url, '/api/workspace/history');
    assert.equal(options.method, undefined);
    assert.equal(options.headers, undefined);
    return Response.json(data);
  });
  assert.deepEqual(await client.listHistory(), data);
});

test('every POST loads the token and sends the expected headers and body', async () => {
  const calls = [];
  const client = createWorkspaceClient(async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/sessions') return Response.json({ token: 'fixture-token' });
    if (url.endsWith('/sessions')) return Response.json({ sessionId: 'new-id' }, { status: 201 });
    return Response.json({ ok: true });
  });

  assert.equal(await client.startSession({ rootId: 'root', relPath: 'web', agent: 'claude', resumeSessionId: 'old-id' }), 'new-id');
  await client.startSession({ rootId: 'root', agent: 'codex' });
  await client.sendMessage('new-id', 'Hello');
  await client.stop('new-id');
  await client.decideApproval('new-id', 'approval-1', 'deny');
  const expected = [
    ['/api/workspace/sessions', { rootId: 'root', relPath: 'web', agent: 'claude', resumeSessionId: 'old-id' }],
    ['/api/workspace/sessions', { rootId: 'root', relPath: '.', agent: 'codex' }],
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
    code: 'turn_active', status: 409, message: 'The previous run is still stopping, retry in a moment',
  });
});

test('a POST rejected with 403 refreshes the token and retries the same request once', async () => {
  let tokenCount = 0;
  const posts = [];
  const client = createWorkspaceClient(async (url, options) => {
    if (url === '/api/sessions') return Response.json({ token: `token-${++tokenCount}` });
    assert.equal(url, '/api/workspace/terminal');
    posts.push(options);
    if (posts.length === 1) return Response.json({ error: 'forbidden' }, { status: 403 });
    return Response.json({ terminalId: 'web-012345abcdef' });
  });

  assert.equal(await client.createTerminal('chat-1', { rootId: 'root', relPath: 'src' }), 'web-012345abcdef');
  assert.equal(tokenCount, 2);
  assert.deepEqual(posts.map(({ method, headers, body }) => [method, headers, JSON.parse(body)]), [1, 2].map((id) => [
    'POST', { 'Content-Type': 'application/json', 'X-Terminal-Request': `token-${id}`, 'X-Workspace-Session': 'chat-1' },
    { rootId: 'root', relPath: 'src' },
  ]));
});

test('a DELETE stops after two 403 responses and exposes the readable error', async () => {
  const calls = [];
  let tokenCount = 0;
  const client = createWorkspaceClient(async (url, options) => {
    if (url === '/api/sessions') return Response.json({ token: `token-${++tokenCount}` });
    calls.push([url, options.method, options.headers['X-Terminal-Request'], options.body]);
    return Response.json({ error: 'forbidden' }, { status: 403 });
  });
  await assert.rejects(client.closeTerminal('web-012345abcdef'), {
    code: 'forbidden', status: 403, message: 'Your workspace access could not be verified. Reload and sign in again.',
  });
  assert.equal(tokenCount, 2);
  assert.deepEqual(calls, [1, 2].map((id) => ['/api/workspace/terminal/web-012345abcdef', 'DELETE', `token-${id}`, undefined]));
});

test('a message POST reports a missing session after token refresh without retrying the 404', async () => {
  for (const explicit of [true, false]) {
    let tokenCount = 0;
    let messages = 0;
    const client = createWorkspaceClient(async (url) => {
      if (url === '/api/sessions') return Response.json({ token: `token-${++tokenCount}` });
      assert.equal(url, '/api/workspace/sessions/old-id/messages');
      if (++messages === 1) return Response.json({ error: 'forbidden' }, { status: 403 });
      return explicit ? Response.json({ error: 'not_found' }, { status: 404 })
        : new Response('Not found', { status: 404 });
    });
    await assert.rejects(client.sendMessage('old-id', 'Hello'), (error) => {
      assert.equal(error.status, 404);
      assert.equal(isMissingSession(error), explicit);
      return true;
    });
    assert.equal(tokenCount, 2);
    assert.equal(messages, 2);
  }
});

test('a 403 fetching the token prevents the mutation without retrying the token GET', async () => {
  const calls = [];
  const client = createWorkspaceClient(async (url) => {
    calls.push(url);
    return Response.json({ error: 'forbidden' }, { status: 403 });
  });
  await assert.rejects(client.sendMessage('old-id', 'Hello'), { code: 'forbidden', status: 403 });
  assert.deepEqual(calls, ['/api/sessions']);
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

test('terminal creation sends the chat reference and project, and deletion refreshes the token', async () => {
  const calls = [];
  let tokenCount = 0;
  const terminalId = 'web-012345abcdef';
  const client = createWorkspaceClient(async (url, options) => {
    calls.push([url, options]);
    if (url === '/api/sessions') return Response.json({ token: `fixture-token-${++tokenCount}` });
    if (options.method === 'POST') return Response.json({ terminalId }, { status: 201 });
    return Response.json({ ok: true });
  });

  assert.equal(await client.createTerminal('chat-1', { rootId: 'root', relPath: 'packages/web' }), terminalId);
  assert.deepEqual(await client.closeTerminal(terminalId), { ok: true });
  assert.deepEqual(calls.map(([url]) => url), [
    '/api/sessions', '/api/workspace/terminal', '/api/sessions', `/api/workspace/terminal/${terminalId}`,
  ]);
  const post = calls[1][1];
  assert.equal(post.method, 'POST');
  assert.deepEqual(post.headers, {
    'Content-Type': 'application/json',
    'X-Terminal-Request': 'fixture-token-1',
    'X-Workspace-Session': 'chat-1',
  });
  assert.deepEqual(JSON.parse(post.body), { rootId: 'root', relPath: 'packages/web' });
  const deletion = calls[3][1];
  assert.equal(deletion.method, 'DELETE');
  assert.deepEqual(deletion.headers, {
    'Content-Type': 'application/json', 'X-Terminal-Request': 'fixture-token-2',
  });
  assert.equal(deletion.body, undefined);
});

test('terminal calls reject unsafe identifiers before using them in headers or URLs', async () => {
  const calls = [];
  const client = createWorkspaceClient(async (url) => {
    calls.push(url);
    if (url === '/api/sessions') return Response.json({ token: 'fixture-token' });
    return Response.json({ terminalId: 'web-012345abcdef/../other' }, { status: 201 });
  });

  await assert.rejects(client.createTerminal('chat\n1', { rootId: 'root' }), { code: 'invalid_session' });
  await assert.rejects(client.closeTerminal('web-012345abcdef/../other'), { code: 'invalid_terminal' });
  assert.deepEqual(calls, []);
  await assert.rejects(client.createTerminal('chat-1', { rootId: 'root' }), { code: 'invalid_response' });
  assert.deepEqual(calls, ['/api/sessions', '/api/workspace/terminal']);
});

test('terminal creation preserves server status and maps errors using the workspace client', async () => {
  let status = 404;
  const client = createWorkspaceClient(async (url) => {
    if (url === '/api/sessions') return Response.json({ token: 'fixture-token' });
    return status === 404 ? new Response('Not found', { status })
      : Response.json({ error: 'project_path_changed' }, { status });
  });

  await assert.rejects(client.createTerminal('chat-1', { rootId: 'root' }), { code: 'not_found', status: 404 });
  status = 409;
  await assert.rejects(client.createTerminal('chat-1', { rootId: 'root' }), {
    code: 'project_path_changed', status: 409, message: 'The project location changed. Start a new session.',
  });
});
