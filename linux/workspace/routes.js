'use strict';

// ASSUMPTION: The host checks owner authentication before dispatch and supplies the
// existing JSON mutation gate as checkRequest. R7 defines the handled methods and
// paths. The configured body cap is also bounded by the corresponding spec cap.
// ASSUMPTION: Projects return { projects: [{ id, label, folders }] }. Creation
// returns 201 with { sessionId }; other successful mutations return 200 with { ok: true }.
// Stop accepts an empty body. An SSE client without a cursor gets the available
// history; a cursor older than that history gets 409 replay_incomplete.
// ASSUMPTION: githubWorkspace supplies the GitHub helpers, runner, workspacesRoot
// and a dedicated rootId registered only with the session manager. Its runner
// enforces repository authorization. GitHub creation provisions a fresh checkout;
// a GitHub request with resumeSessionId is rejected.

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { listProjects, resolveProjectPath } = require('./project-roots');
const { parseGithubRepo } = require('./github-workspace');

const PREFIX = '/api/workspace';
const REPLAY_SIZE = 500;
const MAX_MESSAGE_CHARS = 20_000;
const RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};
const ERROR_STATUS = new Map([
  ['forbidden', 403],
  ['body_too_large', 413],
  ['invalid_json', 400],
  ['invalid_body', 400],
  ['invalid_agent', 400],
  ['invalid_session', 400],
  ['invalid_text', 400],
  ['invalid_decision', 400],
  ['invalid_path', 400],
  ['outside_root', 400],
  ['not_directory', 400],
  ['unknown_root', 400],
  ['not_found', 404],
  ['unknown_session', 404],
  ['unknown_approval', 404],
  ['invalid_repo', 400],
  ['repository_forbidden', 403],
  ['outside_workspaces', 500],
  ['workspace_exists', 409],
  ['clone_failed', 502],
  ['spawn_failed', 500],
  ['resume_unavailable', 409],
  ['resume_not_verified', 409],
  ['turn_active', 409],
  ['max_sessions', 409],
  ['approvals_unsupported', 409],
  ['project_path_changed', 409],
  ['invalid_cursor', 400],
  ['replay_incomplete', 409],
]);

function routeError(code) {
  return Object.assign(new Error(code), { code });
}

function sendJson(res, status, body) {
  res.writeHead(status, { ...RESPONSE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit, allowEmpty) {
  if (Number(req.headers['content-length']) > limit) throw routeError('body_too_large');
  const chunks = [];
  let size = 0;
  // Keep the socket writable so the client can receive a 413 for chunked input.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw routeError('body_too_large');
    chunks.push(chunk);
  }
  if (!size && allowEmpty) return {};

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw routeError('invalid_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw routeError('invalid_body');
  return body;
}

function createWorkspaceRoutes({ roots, sessionManager, githubWorkspace, checkRequest, maxBodyBytes = 16384 }) {
  const histories = new Map();

  function listSessions() {
    const sessions = sessionManager.list();
    const ids = new Set(sessions.map(({ sessionId }) => sessionId));
    for (const [sessionId, history] of histories) {
      if (ids.has(sessionId)) continue;
      history.unsubscribe();
      for (const stream of history.streams) stream.end();
      histories.delete(sessionId);
    }
    return ids;
  }

  function trackEvents(sessionId) {
    const existing = histories.get(sessionId);
    if (existing) return existing;
    const history = {
      events: new Array(REPLAY_SIZE), first: 1, last: 0, streams: new Set(),
    };
    history.unsubscribe = sessionManager.onEvent(sessionId, event => {
      if (!history.last) history.first = event.seq;
      history.events[event.seq % REPLAY_SIZE] = event;
      history.last = event.seq;
      history.first = Math.max(history.first, history.last - REPLAY_SIZE + 1);
      for (const stream of history.streams) stream.send();
    });
    histories.set(sessionId, history);
    return history;
  }

  function streamEvents(req, res, history) {
    const header = req.headers['last-event-id'];
    let cursor = history.first - 1;
    if (header !== undefined) {
      cursor = Number(header);
      if (!/^\d+$/.test(header) || !Number.isSafeInteger(cursor) || cursor > history.last) {
        throw routeError('invalid_cursor');
      }
      if (cursor < history.first - 1) throw routeError('replay_incomplete');
    }

    let waitingForDrain = false;
    const stream = {
      send() {
        if (res.writableEnded || res.destroyed || waitingForDrain) return;
        if (cursor < history.first - 1) return stream.end();
        while (cursor < history.last) {
          cursor += 1;
          const event = history.events[cursor % REPLAY_SIZE];
          if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) {
            waitingForDrain = true;
            return;
          }
        }
      },
      end() {
        history.streams.delete(stream);
        res.end();
      },
    };
    res.on('drain', () => {
      waitingForDrain = false;
      stream.send();
    });
    res.once('close', () => history.streams.delete(stream));
    res.writeHead(200, { ...RESPONSE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.flushHeaders();
    history.streams.add(stream);
    stream.send();
  }

  async function startSession({ rootId, relPath, agent, resumeSessionId, github }) {
    if (agent !== 'claude' && agent !== 'codex') throw routeError('invalid_agent');
    if (resumeSessionId !== undefined && (typeof resumeSessionId !== 'string' || !resumeSessionId)) {
      throw routeError('invalid_session');
    }
    const ids = listSessions();
    if (resumeSessionId !== undefined && !ids.has(resumeSessionId)) throw routeError('unknown_session');

    let managed;
    if (github !== undefined) {
      const repo = parseGithubRepo(github);
      if (!repo.ok) throw routeError(repo.code);
      if (resumeSessionId !== undefined) throw routeError('resume_unavailable');
      const { workspacesRoot, runner } = githubWorkspace;
      managed = await githubWorkspace.createWorkspace({ workspacesRoot, runner, repo, sessionId: randomUUID() });
      if (!managed.ok) throw routeError(managed.code);
      rootId = githubWorkspace.rootId;
      relPath = path.relative(workspacesRoot, managed.path);
      if (!relPath || relPath === '..' || relPath.startsWith(`..${path.sep}`) || path.isAbsolute(relPath)) {
        throw routeError('outside_workspaces');
      }
    } else {
      const resolved = resolveProjectPath(roots, rootId, relPath);
      if (!resolved.ok) throw routeError(resolved.code);
    }

    let sessionId;
    try {
      ({ sessionId } = sessionManager.start({ rootId, relPath, agent, resumeSessionId }));
    } catch (error) {
      if (managed && githubWorkspace.cleanupWorkspace) {
        try {
          await githubWorkspace.cleanupWorkspace({
            workspacesRoot: githubWorkspace.workspacesRoot, runner: githubWorkspace.runner, path: managed.path,
          });
        } catch {
          // Cleanup diagnostics stay internal and the start failure remains authoritative.
        }
      }
      throw error;
    }
    trackEvents(sessionId);
    return { sessionId };
  }

  return async function handle(req, res) {
    const pathname = req.url.split('?', 1)[0];
    const projects = req.method === 'GET' && pathname === `${PREFIX}/projects`;
    const create = req.method === 'POST' && pathname === `${PREFIX}/sessions`;
    const sessionRoute = /^\/api\/workspace\/sessions\/([A-Za-z0-9_-]+)\/(messages|stop|events|approvals\/([A-Za-z0-9_-]+))$/.exec(pathname);
    const [, sessionId, action, approvalId] = sessionRoute ?? [];
    const sessionMethod = action === 'events' ? 'GET' : 'POST';
    if (!projects && !create && (!sessionRoute || req.method !== sessionMethod)) return false;

    try {
      if (req.method !== 'GET' && !await checkRequest(req)) throw routeError('forbidden');
      if (projects) {
        sendJson(res, 200, {
          projects: roots.map(({ id, label }) => ({ id, label, folders: listProjects(roots, id) })),
        });
      } else if (action === 'events') {
        if (!listSessions().has(sessionId)) throw routeError('unknown_session');
        streamEvents(req, res, trackEvents(sessionId));
      } else {
        const routeCap = create ? 4096 : action === 'messages' ? 65536 : 1024;
        const body = await readBody(req, Math.min(maxBodyBytes, routeCap), action === 'stop');
        if (create) {
          sendJson(res, 201, await startSession(body));
        } else {
          if (!listSessions().has(sessionId)) throw routeError('unknown_session');
          trackEvents(sessionId);
          if (action === 'messages') {
            if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_MESSAGE_CHARS) {
              throw routeError('invalid_text');
            }
            sessionManager.send(sessionId, body.text);
          } else if (action === 'stop') {
            sessionManager.stop(sessionId);
          } else {
            if (body.decision !== 'allow' && body.decision !== 'deny') throw routeError('invalid_decision');
            sessionManager.respond(sessionId, approvalId, body.decision);
          }
          sendJson(res, 200, { ok: true });
        }
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (res.headersSent) {
        res.destroy();
      } else {
        const status = ERROR_STATUS.get(error?.code);
        if (status === 413) res.setHeader('Connection', 'close');
        sendJson(res, status ?? 500, { error: status ? error.code : 'internal_error' });
      }
    }
    return true;
  };
}

module.exports = { createWorkspaceRoutes };
