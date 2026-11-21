'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveProjectPath, assertStillInsideRoot } = require('./project-roots');
const {
  CLAUDE_EFFORTS, buildClaudeArgs, createClaudeParser, buildApprovalResponse, buildUserMessage,
} = require('./claude-adapter');
const { CODEX_EFFORTS, buildCodexArgs, createCodexParser, isCliSessionId } = require('./codex-adapter');

// This flag set is marked verified for Claude only. Linux runtime acceptance is separate.
const CLAUDE_ISOLATION_ARGS = ['--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config'];
const BLOCKED_ENV = /^(?:GH_TOKEN$|GITHUB_TOKEN$|SSH_AUTH_SOCK$|AWS_|ANTHROPIC_API_KEY$)/i;
const STARTUP_MS = 30_000;
const TURN_MS = 15 * 60_000;
const APPROVAL_MS = 60_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_REPLAY_EVENTS = 1_000;
const MAX_RETAINED_SESSIONS = 20;
const MAX_HISTORY_ENTRIES = 200;
const MAX_HISTORY_FILE_BYTES = 8 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9._-]+$/;
const AGENT_EFFORTS = { claude: CLAUDE_EFFORTS, codex: CODEX_EFFORTS };
const LUNA_EFFORTS = CODEX_EFFORTS.filter(effort => effort !== 'ultra');
const BUILTIN_MODELS = {
  claude: {
    default: 'claude-sonnet-5-5',
    defaultEffort: 'medium',
    list: [
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
    ],
  },
  codex: {
    default: 'gpt-6.2-sol',
    defaultEffort: 'medium',
    list: [
      { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' },
      { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra' },
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
      { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: LUNA_EFFORTS },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', efforts: LUNA_EFFORTS },
    ],
  },
};

function managerError(code, message = code, status) {
  return Object.assign(new Error(message), { code, ...(status && { status }) });
}

function hasOnlyKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

function validModelId(value) {
  return typeof value === 'string' && MODEL_ID.test(value);
}

function loadModelOptions(config = {}) {
  const invalid = () => managerError('invalid_models_config');
  if (!hasOnlyKeys(config, ['claude', 'codex'])) throw invalid();
  return Object.fromEntries(Object.entries(BUILTIN_MODELS).map(([agent, builtin]) => {
    const settings = Object.hasOwn(config, agent) ? config[agent] : builtin;
    if (!hasOnlyKeys(settings, ['default', 'defaultEffort', 'list']) || !Array.isArray(settings.list)) throw invalid();
    const ids = new Set();
    const models = settings.list.map(model => {
      if (!hasOnlyKeys(model, ['id', 'label', 'efforts'])) throw invalid();
      const allowedEfforts = builtin.list.find(({ id }) => id === model.id)?.efforts ?? AGENT_EFFORTS[agent];
      const { id, label, efforts = allowedEfforts } = model;
      if (!validModelId(id) || ids.has(id) || typeof label !== 'string' || !label.trim() ||
          !Array.isArray(efforts) || !efforts.length || new Set(efforts).size !== efforts.length ||
          !efforts.every(effort => allowedEfforts.includes(effort))) throw invalid();
      ids.add(id);
      return { id, label, efforts: [...efforts] };
    });
    const { default: defaultModel, defaultEffort } = settings;
    if (!models.find(({ id }) => id === defaultModel)?.efforts.includes(defaultEffort)) throw invalid();
    return [agent, { default: defaultModel, defaultEffort, models }];
  }));
}

function selectModel(agents, agent, model, effort) {
  if (agent !== 'claude' && agent !== 'codex') throw managerError('invalid_agent');
  const options = agents[agent];
  const selected = options.models.find(({ id }) => id === (model === undefined ? options.default : model));
  if (!selected) throw managerError('invalid_model');
  if (effort === undefined) {
    effort = selected.efforts.includes(options.defaultEffort) ? options.defaultEffort : selected.efforts[0];
  }
  if (!selected.efforts.includes(effort)) throw managerError('invalid_effort');
  return { model: selected.id, effort };
}

function sanitizedEnv(overrides) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !BLOCKED_ENV.test(key)));
  return Object.assign(env, overrides);
}

function validHistoryEntry(entry) {
  if (!hasOnlyKeys(entry, ['agent', 'rootId', 'relPath', 'cliSessionId', 'lastUsedAt', 'model', 'effort'])) return false;
  const { agent, rootId, relPath, cliSessionId, lastUsedAt, model, effort } = entry;
  return (agent === 'claude' || agent === 'codex') && isCliSessionId(cliSessionId) &&
    ((model === undefined && effort === undefined) || (validModelId(model) && AGENT_EFFORTS[agent].includes(effort))) &&
    typeof rootId === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(rootId) &&
    typeof relPath === 'string' && Buffer.byteLength(relPath) <= 4096 && !path.win32.isAbsolute(relPath) &&
    !/[\\\0]/.test(relPath) && relPath.split('/').every(segment => segment && segment !== '..') &&
    Number.isSafeInteger(lastUsedAt) && lastUsedAt >= 0;
}

function newestHistory(entries) {
  const seen = new Set();
  return entries.filter(validHistoryEntry).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .filter(({ agent, cliSessionId }) => {
      const key = `${agent}:${cliSessionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_HISTORY_ENTRIES);
}

function loadHistory(file) {
  if (!file) return [];
  try {
    if (!fs.lstatSync(path.dirname(file)).isDirectory()) return [];
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stats = fs.fstatSync(fd);
      if (!stats.isFile() || stats.size > MAX_HISTORY_FILE_BYTES) return [];
      const entries = JSON.parse(fs.readFileSync(fd, 'utf8'));
      return Array.isArray(entries) ? newestHistory(entries) : [];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

function saveHistory(file, entries) {
  if (!file) return;
  const parent = path.dirname(file);
  const temp = path.join(parent, `.session-history-${randomUUID()}.tmp`);
  let created = false;
  try {
    if (!fs.lstatSync(parent).isDirectory()) return;
    const fd = fs.openSync(temp, 'wx', 0o600);
    created = true;
    try {
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(entries) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    created = false;
  } catch {
    // A storage failure must not interrupt a coding session.
  } finally {
    if (created) {
      try { fs.unlinkSync(temp); } catch { /* Best-effort cleanup. */ }
    }
  }
}

function createSessionManager({
  roots, spawnFn = spawn, now = Date.now, maxSessions = 8,
  idleMs = 60 * 60_000, killGraceMs = 5_000, env, historyFile, onDiscard = () => {},
  agents = loadModelOptions(), claudeMcpConfigFile,
}) {
  const sessions = new Map();
  const useProcessGroup = process.platform !== 'win32';
  const file = typeof historyFile === 'string' && path.isAbsolute(historyFile) ? historyFile : null;
  let sessionHistory = loadHistory(file);

  function remember({ agent, rootId, relPath, cliSessionId, model, effort }) {
    const entry = { agent, rootId, relPath, cliSessionId, model, effort, lastUsedAt: now() };
    if (!validHistoryEntry(entry)) return;
    sessionHistory = newestHistory([entry, ...sessionHistory.filter(previous =>
      previous.agent !== agent || previous.cliSessionId !== cliSessionId)]);
    saveHistory(file, sessionHistory);
  }

  function listHistory(agent) {
    return sessionHistory.filter(entry => agent === undefined || entry.agent === agent)
      .map(entry => ({ ...entry }));
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw managerError('unknown_session');
    return session;
  }

  function drain(session, subscriber) {
    if (subscriber.delivering) return;
    subscriber.delivering = true;
    try {
      while (session.subscribers.has(subscriber) && subscriber.seq < session.seq) {
        const firstSeq = session.history[0]?.event.seq ?? session.seq + 1;
        const entry = session.history[subscriber.seq + 1 - firstSeq];
        if (!entry) throw managerError('replay_incomplete');
        subscriber.seq = entry.event.seq;
        subscriber.fn(structuredClone(entry.event));
      }
    } catch {
      session.subscribers.delete(subscriber);
    } finally {
      subscriber.delivering = false;
    }
  }

  function emit(session, run, fields) {
    const event = { ...fields, sessionId: session.id, turnId: run.turnId, seq: session.seq + 1 };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    session.seq = event.seq;
    session.history.push({ event, bytes });
    session.replayBytes += bytes;
    while (session.history.length > MAX_REPLAY_EVENTS || session.replayBytes > MAX_STDOUT_BYTES) {
      session.replayBytes -= session.history.shift().bytes;
    }
    for (const subscriber of session.subscribers) drain(session, subscriber);
  }

  function forget(session) {
    clearTimeout(session.idleTimer);
    if (sessions.delete(session.id) && !session.discard) onDiscard(session.id);
    session.subscribers.clear();
    session.history.length = 0;
  }

  function checkIdle(session) {
    const run = session.run;
    if (session.discard || run?.sent || run?.ending) return;
    clearTimeout(session.idleTimer);
    const remaining = idleMs - (now() - session.lastActivity);
    if (remaining > 0) {
      session.idleTimer = setTimeout(() => checkIdle(session), remaining);
      session.idleTimer.unref();
    } else if (run) {
      session.discard = true;
      onDiscard(session.id);
      finish(session, run, { status: 'cancelled' });
    } else {
      forget(session);
    }
  }

  function signal(run, name) {
    if (!run.child.pid) return;
    try {
      if (useProcessGroup) process.kill(-run.child.pid, name);
      else run.child.kill(name);
    } catch (error) {
      if (error.code !== 'ESRCH') run.child.kill(name);
    }
  }

  function finish(session, run, result, error) {
    if (run.ending) return;
    run.ending = true;
    clearTimeout(run.startupTimer);
    clearTimeout(run.turnTimer);
    for (const approval of run.approvals.values()) clearTimeout(approval.timer);
    run.approvals.clear();
    if (!run.closed) {
      signal(run, 'SIGTERM');
      run.killTimer = setTimeout(() => signal(run, 'SIGKILL'), killGraceMs);
      run.killTimer.unref();
    }
    remember(session);
    if (error) emit(session, run, { type: 'error', ...error });
    emit(session, run, { ...result, type: 'turn_finished' });
  }

  function fail(session, run, code, message) {
    finish(session, run, { status: 'error' }, { code, message });
  }

  function write(session, run, payload, end, onWritten) {
    const callback = error => {
      if (error) fail(session, run, 'stdin_failed', 'Agent input could not be written');
      else if (!run.ending) onWritten?.();
    };
    if (end) run.child.stdin.end(payload, callback);
    else run.child.stdin.write(payload, callback);
  }

  function decide(session, run, approvalId, decision) {
    const approval = run?.approvals.get(approvalId);
    if (!approval || run.ending || approval.responding) throw managerError('unknown_approval');
    const payload = buildApprovalResponse({ requestId: approval.requestId, decision });
    clearTimeout(approval.timer);
    approval.responding = true;
    write(session, run, payload, false, () => {
      run.approvals.delete(approvalId);
      emit(session, run, { type: 'approval_decision', approvalId, decision });
    });
  }

  function parseLine(session, run, line) {
    if (!line.trim()) return;
    for (const event of run.parser.push(line)) {
      if (run.ending) return;
      switch (event.type) {
        case 'session_started': {
          const { cliSessionId } = event;
          if (session.cliSessionId && cliSessionId !== session.cliSessionId) {
            fail(session, run, 'resume_mismatch', 'Agent returned an unexpected resume identifier');
            break;
          }
          if (isCliSessionId(cliSessionId)) {
            session.cliSessionId = cliSessionId;
            remember(session);
          }
          if (session.started) break;
          session.started = true;
          emit(session, run, { ...event, cliSessionId: session.cliSessionId });
          break;
        }
        case 'approval_request': {
          if (typeof event.approvalId !== 'string' || !event.approvalId ||
              !run.sent || run.requestIds.has(event.approvalId)) break;
          const approvalId = randomUUID();
          const timer = setTimeout(() => decide(session, run, approvalId, 'deny'), APPROVAL_MS);
          timer.unref();
          run.approvals.set(approvalId, { requestId: event.approvalId, timer });
          run.requestIds.add(event.approvalId);
          emit(session, run, { ...event, approvalId });
          break;
        }
        case 'approval_decision':
          // Decisions are acknowledged by the manager after writing to stdin.
          break;
        case 'error':
          if (event.code === 'MALFORMED_JSON' || event.code === 'invalid_json') {
            fail(session, run, 'invalid_agent_output', 'Agent emitted an invalid JSON record');
            break;
          }
          emit(session, run, {
            type: 'error', code: 'agent_error', message: 'Agent reported an error',
          });
          break;
        case 'turn_finished':
          // Validate the payload before marking the run finished. A deeply nested
          // usage record may parse successfully but exceed serialization limits.
          JSON.stringify(event);
          finish(session, run, event);
          break;
        default:
          emit(session, run, event);
      }
    }
  }

  function readStdout(session, run, chunk) {
    if (run.ending) return;
    run.stdoutBytes += chunk.length;
    if (run.stdoutBytes > MAX_STDOUT_BYTES) {
      fail(session, run, 'stdout_limit', 'Agent output exceeded the session limit');
      return;
    }
    let start = 0;
    while (start < chunk.length && !run.ending) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      run.frameBytes += end - start;
      if (run.frameBytes > MAX_FRAME_BYTES) {
        fail(session, run, 'stdout_limit', 'Agent output exceeded the frame limit');
        return;
      }
      if (end > start) run.frame.push(chunk.subarray(start, end));
      if (newline === -1) return;
      flushFrame(session, run);
      start = end + 1;
    }
  }

  function flushFrame(session, run) {
    if (!run.frameBytes) return;
    const line = Buffer.concat(run.frame, run.frameBytes).toString('utf8').replace(/\r$/, '');
    run.frame = [];
    run.frameBytes = 0;
    try {
      parseLine(session, run, line);
    } catch {
      fail(session, run, 'invalid_agent_output', 'Agent emitted an invalid event');
    }
  }

  function attachChild(session, run) {
    const { child } = run;
    const streamFailure = () => fail(session, run, 'stream_failed', 'Agent communication failed');
    const stderr = Buffer.alloc(MAX_STDERR_BYTES);
    let stderrBytes = 0;
    child.stdout.on('data', chunk => readStdout(session, run, chunk));
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.copy(stderr, stderrBytes);
    });
    child.stdout.on('error', streamFailure);
    child.stderr.on('error', streamFailure);
    child.stdin.on('error', streamFailure);
    child.once('spawn', () => clearTimeout(run.startupTimer));
    child.once('error', () => fail(session, run, 'spawn_failed', 'Agent process could not be started'));
    child.once('close', () => {
      run.closed = true;
      clearTimeout(run.killTimer);
      if (!run.ending) flushFrame(session, run);
      if (!run.ending) {
        // A byte count provides a bounded diagnostic without exposing any stderr content.
        const diagnostic = stderrBytes ? ' Agent diagnostics were withheld.' : '';
        fail(session, run, 'unexpected_exit', 'Agent exited before completing the turn.' + diagnostic);
      }
      stderr.fill(0);
      session.run = null;
      if (session.discard) forget(session);
      else {
        session.lastActivity = now();
        checkIdle(session);
        const inactive = [...sessions.values()].filter(entry => !entry.run);
        if (inactive.length > MAX_RETAINED_SESSIONS) {
          inactive.sort((a, b) => a.lastActivity - b.lastActivity);
          forget(inactive[0]);
        }
      }
    });
  }

  function launch(session, resolved) {
    if ([...sessions.values()].filter(entry => entry.run).length >= maxSessions) {
      throw managerError('max_sessions', 'Maximum number of active sessions reached', 409);
    }
    const { agent, cliSessionId: resumeSessionId, model, effort } = session;
    const claude = agent === 'claude';
    const args = claude
      ? [...buildClaudeArgs({ approvalMode: 'prompt', resumeSessionId, model, effort, mcpConfigFile: claudeMcpConfigFile }),
        ...CLAUDE_ISOLATION_ARGS]
      : buildCodexArgs({ sandbox: 'read-only', resumeSessionId, model, effort });
    const options = {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: useProcessGroup, env: sanitizedEnv(env),
    };
    const run = {
      turnId: randomUUID(),
      parser: (claude ? createClaudeParser : createCodexParser)({ sessionId: session.id }),
      approvals: new Map(), requestIds: new Set(), frame: [], frameBytes: 0, stdoutBytes: 0,
    };
    session.run = run;
    try {
      const checked = assertStillInsideRoot(roots, resolved);
      if (!checked.ok) throw managerError(checked.code);
      if (checked.absolutePath !== resolved.absolutePath || checked.absolutePath !== session.absolutePath) {
        throw managerError('project_path_changed');
      }
      options.cwd = checked.absolutePath;
      try {
        run.child = spawnFn(session.agent, args, options);
      } catch {
        throw managerError('spawn_failed', 'Agent process could not be started');
      }
    } catch (error) {
      session.run = null;
      throw error;
    }
    session.lastActivity = now();
    run.startupTimer = setTimeout(() => fail(session, run, 'startup_timeout', 'Agent startup timed out'), STARTUP_MS);
    run.startupTimer.unref();
    attachChild(session, run);
    checkIdle(session);
    return run;
  }

  function resolve(rootId, relPath) {
    const resolved = resolveProjectPath(roots, rootId, relPath);
    if (!resolved.ok) throw managerError(resolved.code);
    return resolved;
  }

  function start({ rootId, relPath, agent, resumeSessionId, ownerId, model, effort }) {
    const selection = selectModel(agents, agent, model, effort);
    const resolved = resolve(rootId, relPath);
    for (const session of sessions.values()) checkIdle(session);

    let cliSessionId;
    let previousSession;
    if (resumeSessionId !== undefined) {
      if (!isCliSessionId(resumeSessionId)) {
        throw managerError('resume_unavailable');
      }
      // Older Claude clients can also supply the live workspace session ID.
      const sameProject = entry => entry.agent === agent && entry.rootId === rootId && entry.relPath === relPath;
      const session = [...sessions.values()].find(entry =>
        sameProject(entry) &&
        !entry.discard && entry.ownerId === ownerId && entry.cliSessionId &&
        (entry.cliSessionId === resumeSessionId || (agent === 'claude' && entry.id === resumeSessionId)));
      if (session) {
        if (session.run) throw managerError('turn_active', 'An agent process is already active', 409);
        if (session.model === selection.model && session.effort === selection.effort) {
          launch(session, resolved);
          return { sessionId: session.id };
        }
        if (session.absolutePath !== resolved.absolutePath) throw managerError('project_path_changed');
        previousSession = session;
        cliSessionId = session.cliSessionId;
      } else {
        if (!sessionHistory.some(entry => entry.cliSessionId === resumeSessionId && sameProject(entry))) {
          throw managerError('resume_unavailable');
        }
        if ([...sessions.values()].some(entry => entry.agent === agent && entry.cliSessionId === resumeSessionId && entry.run)) {
          throw managerError('turn_active', 'An agent process is already active', 409);
        }
        cliSessionId = resumeSessionId;
      }
    }

    const session = {
      id: randomUUID(), rootId, relPath, agent, cliSessionId, ownerId, absolutePath: resolved.absolutePath, ...selection,
      seq: 0, history: [], replayBytes: 0, subscribers: new Set(),
    };
    sessions.set(session.id, session);
    try {
      launch(session, resolved);
    } catch (error) {
      forget(session);
      throw error;
    }
    if (previousSession) forget(previousSession);
    return { sessionId: session.id };
  }

  function send(sessionId, text) {
    const session = getSession(sessionId);
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    checkIdle(session);
    if (!sessions.has(sessionId)) throw managerError('unknown_session');
    if (session.discard || session.run?.sent || session.run?.ending) {
      throw managerError('turn_active', 'An agent process is already active', 409);
    }
    if (!session.run && session.started && !session.cliSessionId) {
      throw managerError('resume_unavailable');
    }
    const run = session.run ?? launch(session, resolve(session.rootId, session.relPath));
    run.sent = true;
    clearTimeout(session.idleTimer);
    run.turnTimer = setTimeout(() => fail(session, run, 'turn_timeout', 'Agent turn timed out'), TURN_MS);
    run.turnTimer.unref();
    const claude = session.agent === 'claude';
    write(session, run, claude ? buildUserMessage(text) : text, !claude);
  }

  function onEvent(sessionId, fn, afterSeq) {
    const session = getSession(sessionId);
    if (typeof fn !== 'function') throw new TypeError('fn must be a function');
    const earliest = session.history[0]?.event.seq ?? session.seq + 1;
    const seq = afterSeq ?? earliest - 1;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > session.seq) throw managerError('invalid_cursor');
    if (seq < earliest - 1) throw managerError('replay_incomplete');
    const subscriber = { fn, seq };
    session.subscribers.add(subscriber);
    drain(session, subscriber);
    return () => session.subscribers.delete(subscriber);
  }

  function respond(sessionId, approvalId, decision) {
    const session = getSession(sessionId);
    if (session.agent === 'codex') throw managerError('approvals_unsupported');
    decide(session, session.run, approvalId, decision);
  }

  function terminalProject(sessionId) {
    const session = getSession(sessionId);
    checkIdle(session);
    if (session.discard || !sessions.has(sessionId)) throw managerError('unknown_session');
    const { rootId, relPath, absolutePath, ownerId } = session;
    return { rootId, relPath, absolutePath, ownerId };
  }

  function stop(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || session.discard) return;
    session.discard = true;
    onDiscard(sessionId);
    clearTimeout(session.idleTimer);
    if (session.run) finish(session, session.run, { status: 'cancelled' });
    else forget(session);
  }

  function list() {
    for (const session of sessions.values()) checkIdle(session);
    return [...sessions.values()].map(({ id, rootId, relPath, agent, cliSessionId, model, effort, run }) => ({
      sessionId: id, agent, rootId, relPath, cliSessionId: cliSessionId ?? null, model, effort,
      status: run ? 'active' : 'idle',
    }));
  }

  return { start, send, onEvent, respond, stop, list, listHistory, terminalProject };
}

module.exports = { createSessionManager, loadModelOptions, selectModel };
