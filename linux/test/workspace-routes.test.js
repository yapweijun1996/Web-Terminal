'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { loadProjectRoots } = require('../workspace/project-roots');
const { createWorkspaceRoutes } = require('../workspace/routes');

const API = '/api/workspace';
const SESSION_INPUT = { rootId: 'work', relPath: 'project', agent: 'claude' };
const CLI_SESSION_ID = 'c6cecb23-d965-4b2a-a68c-f975304021a2';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const historyEntries = [
  { ...SESSION_INPUT, cliSessionId: CLI_SESSION_ID, lastUsedAt: 20 },
  { ...SESSION_INPUT, agent: 'codex', cliSessionId: 'codex-thread', lastUsedAt: 10 },
];

function fakeManager() {
  const sessions = new Map();
  const calls = [];
  return {
    calls,
    start(input) {
      calls.push(['start', input]);
      if (input.resumeSessionId) {
        const match = this.list().find(session => session.cliSessionId === input.resumeSessionId);
        const code = input.agent === 'codex' ? 'resume_not_verified' : 'resume_unavailable';
        if (input.agent === 'codex' || !match) throw Object.assign(new Error(code), { code });
        return { sessionId: match.sessionId };
      }
      const sessionId = `session-${sessions.size + 1}`;
      const { agent, rootId, relPath } = input;
      sessions.set(sessionId, { agent, rootId, relPath, events: [], listeners: new Set() });
      this.emit(sessionId, { type: 'session_started' });
      return { sessionId };
    },
    list() {
      return [...sessions].map(([sessionId, { agent, rootId, relPath }]) => ({
        sessionId, agent, rootId, relPath, cliSessionId: CLI_SESSION_ID, status: 'idle', absolutePath: '/internal/path',
      }));
    },
    listHistory(agent) {
      return historyEntries.filter(entry => agent === undefined || entry.agent === agent)
        .map(entry => ({ ...entry, absolutePath: '/internal/path', prompt: 'private prompt' }));
    },
    send(sessionId, text) {
      calls.push(['send', sessionId, text]);
    },
    respond(sessionId, approvalId, decision) {
      calls.push(['respond', sessionId, approvalId, decision]);
    },
    stop(sessionId) {
      calls.push(['stop', sessionId]);
      this.emit(sessionId, { type: 'turn_finished', status: 'cancelled' });
      sessions.delete(sessionId);
    },
    onEvent(sessionId, listener) {
      const session = sessions.get(sessionId);
      if (!session) throw Object.assign(new Error('Missing session'), { code: 'unknown_session' });
      session.listeners.add(listener);
      for (const event of session.events) listener(event);
      return () => session.listeners.delete(listener);
    },
    emit(sessionId, fields) {
      const session = sessions.get(sessionId);
      const event = { ...fields, sessionId, turnId: 'turn-1', seq: session.events.length + 1 };
      session.events.push(event);
      for (const listener of session.listeners) listener(event);
      return event;
    },
  };
}

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-routes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, 'private-project-root');
  const workspacesRoot = path.join(directory, 'private-managed-root');
  fs.mkdirSync(path.join(projectRoot, 'project'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.hidden'));
  fs.mkdirSync(workspacesRoot);
  fs.writeFileSync(path.join(projectRoot, 'file.txt'), 'not a project');
  fs.symlinkSync(workspacesRoot, path.join(projectRoot, 'escape'));
  const roots = loadProjectRoots({ roots: [{ id: 'work', label: 'Work', path: projectRoot }] });
  const sessionManager = fakeManager();
  const githubCalls = [];
  const githubWorkspace = {
    workspacesRoot,
    rootId: 'managed',
    async createWorkspace(input) {
      githubCalls.push(input);
      if (input.repo.repo === 'private-failure') {
        return { ok: false, code: 'clone_failed', message: `stderr with ${workspacesRoot}` };
      }
      if (input.repo.repo === 'outside') return { ok: true, path: projectRoot };
      return { ok: true, path: path.join(workspacesRoot, input.repo.owner, input.repo.repo, input.sessionId) };
    },
  };
  const gateCalls = [];
  const handle = createWorkspaceRoutes({
    roots, sessionManager, githubWorkspace,
    checkRequest(req) {
      gateCalls.push(req.method);
      return req.headers['content-type'] === 'application/json';
    },
    ...options,
  });
  const fallthrough = [];
  let serverError;
  const server = http.createServer(async (req, res) => {
    try {
      if (await handle(req, res)) return;
      fallthrough.push({ headersSent: res.headersSent, writableEnded: res.writableEnded });
      res.writeHead(404).end('fallback');
    } catch (error) {
      serverError = error;
      res.destroy();
    }
  });
  t.after(async () => {
    if (server.listening) {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
    assert.ifError(serverError);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  function open(method, pathname, { body, chunks, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: server.address().port, path: pathname, method, headers, agent: false,
      }, resolve);
      req.on('error', reject);
      if (chunks) {
        for (const chunk of chunks) req.write(chunk);
      }
      req.end(body);
    });
  }

  async function request(method, pathname, input) {
    const res = await open(method, pathname, input);
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = res.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : raw;
    return { status: res.statusCode, headers: res.headers, body, raw };
  }

  function post(pathname, body) {
    return request('POST', pathname, { body: JSON.stringify(body), headers: JSON_HEADERS });
  }

  async function createSession() {
    const result = await post(`${API}/sessions`, SESSION_INPUT);
    assert.equal(result.status, 201);
    return result.body.sessionId;
  }

  return { open, request, post, createSession, directory, sessionManager, githubCalls, gateCalls, fallthrough };
}

function assertHeaders(headers) {
  assert.equal(headers['cache-control'], 'no-store');
  assert.equal(headers['x-content-type-options'], 'nosniff');
}

function assertError(result, status, code) {
  assert.equal(result.status, status);
  assert.deepEqual(result.body, { error: code });
  assertHeaders(result.headers);
}

async function* readEvents(response) {
  response.setEncoding('utf8');
  let pending = '';
  for await (const chunk of response) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n\n')) !== -1) {
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const [, id, data] = /^id: (\d+)\ndata: (.+)$/.exec(frame);
      yield { id: Number(id), data: JSON.parse(data) };
    }
  }
}

test('lists only root identifiers, labels, and contained subfolder names', async t => {
  const { request, directory, gateCalls } = await fixture(t);
  const result = await request('GET', `${API}/projects`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { projects: [{ id: 'work', label: 'Work', folders: ['project'] }] });
  assert.ok(!result.raw.includes(directory));
  assert.deepEqual(gateCalls, []);
  assertHeaders(result.headers);
});

test('lists only public session metadata and resumes by CLI UUID', async t => {
  const { post, request, sessionManager } = await fixture(t);
  assert.deepEqual((await request('GET', `${API}/sessions`)).body, { sessions: [] });
  const created = await post(`${API}/sessions`, { ...SESSION_INPUT, path: '/untrusted' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { sessionId: 'session-1' });
  assertHeaders(created.headers);
  const listed = await request('GET', `${API}/sessions`);
  assert.equal(listed.status, 200);
  assertHeaders(listed.headers);
  assert.deepEqual(listed.body, {
    sessions: [{ ...SESSION_INPUT, sessionId: 'session-1', cliSessionId: CLI_SESSION_ID, status: 'idle' }],
  });
  const resumed = await post(`${API}/sessions`, { ...SESSION_INPUT, resumeSessionId: CLI_SESSION_ID });
  assert.equal(resumed.status, 201);
  assert.deepEqual(resumed.body, created.body);
  assert.deepEqual(sessionManager.calls, [
    ['start', { ...SESSION_INPUT, resumeSessionId: undefined }],
    ['start', { ...SESSION_INPUT, resumeSessionId: CLI_SESSION_ID }],
  ]);
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, resumeSessionId: 'missing' }), 409, 'resume_unavailable');
  assertError(await post(`${API}/sessions`, {
    ...SESSION_INPUT, agent: 'codex', resumeSessionId: CLI_SESSION_ID,
  }), 409, 'resume_not_verified');
});

test('lists only public history metadata and supports an agent filter', async t => {
  const { request, gateCalls } = await fixture(t);
  const result = await request('GET', `${API}/history`);
  assert.equal(result.status, 200);
  assertHeaders(result.headers);
  assert.deepEqual(result.body, { entries: historyEntries });
  assert.ok(!result.raw.includes('/internal/path'));
  assert.deepEqual((await request('GET', `${API}/history?agent=claude`)).body, { entries: historyEntries.slice(0, 1) });
  assert.deepEqual((await request('GET', `${API}/history?agent=codex`)).body, { entries: historyEntries.slice(1) });
  assertError(await request('GET', `${API}/history?agent=unknown`), 400, 'invalid_agent');
  assert.deepEqual(gateCalls, []);
});

test('rejects invalid agents, traversal, and symlinks outside an admin root', async t => {
  const { post, sessionManager } = await fixture(t);
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, agent: 'other' }), 400, 'invalid_agent');
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, relPath: '../outside' }), 400, 'invalid_path');
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, relPath: 'escape' }), 400, 'outside_root');
  assert.deepEqual(sessionManager.calls, []);
});

test('provisions GitHub sessions without using a client-supplied path or root', async t => {
  const { post, githubCalls, sessionManager, directory } = await fixture(t);
  const result = await post(`${API}/sessions`, {
    ...SESSION_INPUT, github: 'owner/repo', rootId: 'client-root', relPath: '/client/path', path: '/another/path',
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, { sessionId: 'session-1' });
  assert.equal(githubCalls.length, 1);
  const [provision] = githubCalls;
  assert.equal(provision.workspacesRoot, path.join(directory, 'private-managed-root'));
  assert.equal(provision.repo.owner, 'owner');
  assert.equal(provision.repo.repo, 'repo');
  assert.match(provision.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sessionManager.calls, [
    ['start', {
      rootId: 'managed', relPath: path.join('owner', 'repo', provision.sessionId),
      agent: 'claude', resumeSessionId: undefined,
    }],
  ]);
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, github: 'not-a-repo' }), 400, 'invalid_repo');
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, github: 'owner/private-failure' }), 502, 'clone_failed');
  assertError(await post(`${API}/sessions`, { ...SESSION_INPUT, github: 'owner/outside' }), 500, 'outside_workspaces');
  assertError(await post(`${API}/sessions`, {
    ...SESSION_INPUT, github: 'owner/repo', resumeSessionId: CLI_SESSION_ID,
  }), 409, 'github_resume_unsupported');
  assert.equal(githubCalls.length, 3);
  assert.equal(sessionManager.calls.length, 1);
});

test('enforces the request gate before consuming or validating the body', async t => {
  const { request, gateCalls, sessionManager } = await fixture(t, { maxBodyBytes: 64 });
  const result = await request('POST', `${API}/sessions`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': 128 },
    body: 'x'.repeat(128),
  });
  assertError(result, 403, 'forbidden');
  assert.deepEqual(gateCalls, ['POST']);
  assert.deepEqual(sessionManager.calls, []);
});

test('enforces the byte cap for declared and chunked request bodies', async t => {
  const { request, sessionManager } = await fixture(t, { maxBodyBytes: 64 });
  assertError(await request('POST', `${API}/sessions`, {
    headers: { ...JSON_HEADERS, 'Content-Length': 65 }, body: 'x'.repeat(65),
  }), 413, 'body_too_large');
  assertError(await request('POST', `${API}/sessions`, {
    headers: JSON_HEADERS, chunks: ['é'.repeat(20), 'é'.repeat(20)],
  }), 413, 'body_too_large');
  assert.deepEqual(sessionManager.calls, []);
});

test('rejects malformed JSON and JSON values that are not objects', async t => {
  const { request, post } = await fixture(t);
  assertError(await request('POST', `${API}/sessions`, { headers: JSON_HEADERS, body: '{' }), 400, 'invalid_json');
  assertError(await post(`${API}/sessions`, []), 400, 'invalid_body');
});

test('forwards messages, approval decisions, and stop to the session manager', async t => {
  const { createSession, post, request, sessionManager, gateCalls } = await fixture(t, { maxBodyBytes: 65536 });
  const id = await createSession();
  const session = `${API}/sessions/${id}`;
  const text = 'x'.repeat(20_000);
  assert.deepEqual((await post(`${session}/messages`, { text })).body, { ok: true });
  assertError(await post(`${session}/messages`, { text: text + 'x' }), 400, 'invalid_text');
  for (const decision of ['allow', 'deny']) {
    assert.deepEqual((await post(`${session}/approvals/approval-1`, { decision, message: '' })).body, { ok: true });
  }
  assertError(await post(`${session}/approvals/approval-1`, { decision: 'other' }), 400, 'invalid_decision');
  const stopped = await request('POST', `${session}/stop`, { headers: JSON_HEADERS });
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body, { ok: true });
  assertHeaders(stopped.headers);
  assert.deepEqual(sessionManager.calls.slice(1), [
    ['send', id, text],
    ['respond', id, 'approval-1', 'allow'],
    ['respond', id, 'approval-1', 'deny'],
    ['stop', id],
  ]);
  assert.deepEqual(gateCalls, Array(7).fill('POST'));
});

test('returns 404 from each session-scoped endpoint for an unknown session', async t => {
  const { request, post } = await fixture(t);
  const missing = `${API}/sessions/missing`;
  assertError(await request('GET', `${missing}/events`), 404, 'unknown_session');
  assertError(await post(`${missing}/messages`, { text: 'hi' }), 404, 'unknown_session');
  assertError(await post(`${missing}/approvals/approval-1`, { decision: 'deny' }), 404, 'unknown_session');
  assertError(await post(`${missing}/stop`, {}), 404, 'unknown_session');
});

test('streams unified events and replays only events newer than Last-Event-ID', { timeout: 5000 }, async t => {
  const { createSession, open, sessionManager } = await fixture(t);
  const id = await createSession();
  const eventsPath = `${API}/sessions/${id}/events`;
  const initial = await open('GET', eventsPath);
  assert.equal(initial.statusCode, 200);
  assert.match(initial.headers['content-type'], /^text\/event-stream/);
  assertHeaders(initial.headers);
  const live = readEvents(initial);
  assert.deepEqual((await live.next()).value, {
    id: 1, data: { type: 'session_started', sessionId: id, turnId: 'turn-1', seq: 1 },
  });
  const first = sessionManager.emit(id, { type: 'message_delta', messageId: 'message-1', text: 'first\nline' });
  assert.deepEqual((await live.next()).value, { id: 2, data: first });
  await live.return();

  const missed = sessionManager.emit(id, { type: 'message_done', messageId: 'message-1', text: 'complete' });
  const resumed = readEvents(await open('GET', eventsPath, { headers: { 'Last-Event-ID': '2' } }));
  assert.deepEqual((await resumed.next()).value, { id: 3, data: missed });
  const finished = sessionManager.emit(id, { type: 'turn_finished', status: 'success' });
  assert.deepEqual((await resumed.next()).value, { id: 4, data: finished });
  await resumed.return();
});

test('retains exactly 500 SSE events and rejects stale or invalid replay cursors', { timeout: 5000 }, async t => {
  const { createSession, open, request, sessionManager } = await fixture(t);
  const id = await createSession();
  const eventsPath = `${API}/sessions/${id}/events`;
  for (let seq = 2; seq <= 502; seq++) {
    sessionManager.emit(id, { type: 'message_delta', messageId: 'message-1', text: String(seq) });
  }
  for (const cursor of ['-1', '503']) {
    assertError(await request('GET', eventsPath, { headers: { 'Last-Event-ID': cursor } }), 400, 'invalid_cursor');
  }
  assertError(await request('GET', eventsPath, { headers: { 'Last-Event-ID': '1' } }), 409, 'replay_incomplete');
  const replay = readEvents(await open('GET', eventsPath, { headers: { 'Last-Event-ID': '2' } }));
  for (let seq = 3; seq <= 502; seq++) {
    const { value } = await replay.next();
    assert.equal(value.id, seq);
    assert.equal(value.data.seq, seq);
  }
  await replay.return();
});

test('leaves unknown paths and methods to the host without writing', async t => {
  const { request, fallthrough, gateCalls } = await fixture(t);
  for (const [method, pathname] of [
    ['GET', '/other'],
    ['POST', `${API}/other`],
    ['GET', `${API}/sessions/id/messages`],
    ['POST', `${API}/sessions/id/events`],
  ]) {
    const result = await request(method, pathname);
    assert.equal(result.body, 'fallback');
  }
  assert.deepEqual(fallthrough, Array(4).fill({ headersSent: false, writableEnded: false }));
  assert.deepEqual(gateCalls, []);
});
