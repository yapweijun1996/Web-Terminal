'use strict';

const { execFile, spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const github = require('./github-workspace');
const { loadProjectRoots, resolveProjectPath, assertStillInsideRoot } = require('./project-roots');
const { createSessionManager, loadModelOptions } = require('./session-manager');
const { createWorkspaceRoutes } = require('./routes');

const execute = promisify(execFile);
const githubRootId = 'managed-github';
const agentEnvKey = /^(?:PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z_]+|TERM|TMPDIR|CODEX_HOME)$/;

function repositoryKey({ owner, repo }) {
  return `${owner}/${repo}`.toLowerCase();
}

async function runGit(command, args, { cwd, env, timeoutMs }) {
  if (args[0] === 'clone') {
    args = ['-c', 'credential.helper=!gh auth git-credential', ...args];
    env = { ...env, HOME: homedir() };
    for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  try {
    const { stdout } = await execute(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout };
  } catch {
    return { code: 1 };
  }
}

function inside(parent, directory) {
  const relative = path.relative(parent, directory);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function resolveClaudeMcpFile(file, projectPaths) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Invalid MCP configuration');
  const canonical = fs.realpathSync.native(file);
  const stats = fs.statSync(canonical);
  const mode = stats.mode & 0o7777;
  if (!stats.isFile() || (mode !== 0o600 && mode !== 0o400) ||
      projectPaths.some(root => inside(root, file) || inside(root, canonical))) {
    throw new Error('Invalid MCP configuration');
  }
  return canonical;
}

function loadClaudeMcpFile(mcp, projectPaths) {
  if (mcp === undefined) return undefined;
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp) || Object.keys(mcp).some(key => key !== 'claude')) {
    throw new Error('Invalid MCP configuration');
  }
  if (!Object.hasOwn(mcp, 'claude')) return undefined;
  const { claude } = mcp;
  if (!claude || typeof claude !== 'object' || Object.keys(claude).length !== 1 || !Object.hasOwn(claude, 'configFile')) {
    throw new Error('Invalid MCP configuration');
  }
  return resolveClaudeMcpFile(claude.configFile, projectPaths);
}

function checkCodexHome(directory) {
  const ownerHome = path.join(homedir(), '.codex');
  let canonicalOwnerHome = ownerHome;
  try {
    canonicalOwnerHome = fs.realpathSync(ownerHome);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (inside(ownerHome, directory) || inside(directory, ownerHome) ||
      inside(canonicalOwnerHome, directory) || inside(directory, canonicalOwnerHome)) {
    throw new Error('A dedicated Codex home is required');
  }
}

function terminalError(code) {
  return Object.assign(new Error(code), { code });
}

function createWorkspaceTerminals({ service, roots, getProject }) {
  const runtimeMarker = createHash('sha256').update(service.runtime).digest('hex').slice(0, 16);
  const byChat = new Map();
  const byName = new Map();

  async function owner(req) {
    try {
      const identity = await service.verifyOwner(req);
      if (identity?.authorized === true && typeof identity.ownerId === 'string' && identity.ownerId &&
          Number.isSafeInteger(identity.expires) && identity.expires > Date.now()) return identity.ownerId;
    } catch {
      // The verifier can fail independently of the terminal server.
    }
    throw terminalError('authority_unavailable');
  }

  function isLive(record) {
    return service.marker(record.name) === record.marker;
  }

  function close(record) {
    record.active = false;
    if (record.closed) return;
    try {
      service.close(record.name, record);
    } catch (error) {
      if (isLive(record)) throw error;
    }
    // Keep the owner binding so a repeated DELETE cannot target a replacement.
    record.closed = true;
    if (byChat.get(record.chatId) === record) byChat.delete(record.chatId);
  }

  function closeChat(chatId) {
    const record = byChat.get(chatId);
    if (!record) return;
    try { close(record); } catch { /* A failed close remains blocked and can be retried. */ }
  }

  function reclaimOrphans() {
    let snapshot;
    try {
      snapshot = service.tmux(['list-sessions', '-F', '#{session_name}|#{session_id}|#{pid}|#{@web-workspace-terminal}']);
    } catch {
      return;
    }
    for (const line of snapshot.trim().split('\n')) {
      const [name, sessionId, serverPid, marker] = line.split('|');
      if (!/^web-[a-f0-9]{12}$/.test(name) || !/^\$\d+$/.test(sessionId) || !/^\d+$/.test(serverPid) ||
          !/^[a-f0-9]{48}$/.test(marker) || !marker.startsWith(runtimeMarker)) continue;
      try { service.close(name, { sessionId, serverPid, marker }); } catch { /* The marker keeps orphans inaccessible. */ }
    }
  }

  reclaimOrphans();
  return {
    owner,
    open(ownerId, chatId, body) {
      if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(chatId)) throw terminalError('unknown_session');
      const project = getProject(chatId);
      if (project.ownerId !== ownerId) throw terminalError('forbidden');

      const { rootId, relPath } = body;
      if (Object.keys(body).length !== 2 || typeof rootId !== 'string' || typeof relPath !== 'string') {
        throw terminalError('invalid_body');
      }
      const managed = project.rootId === githubRootId;
      if (rootId === githubRootId && !managed) throw terminalError('unknown_root');
      if (managed && (rootId !== githubRootId || (relPath !== '.' && relPath !== project.relPath))) {
        throw terminalError('forbidden');
      }
      const requested = managed ? project.relPath : relPath;
      const resolved = resolveProjectPath(roots, rootId, requested);
      if (!resolved.ok) throw terminalError(resolved.code);
      if (rootId !== project.rootId || requested !== project.relPath) throw terminalError('forbidden');
      if (resolved.absolutePath !== project.absolutePath) throw terminalError('project_path_changed');

      const existing = byChat.get(chatId);
      if (existing?.active && isLive(existing)) return existing.name;
      if (existing) close(existing);
      if (!service.hasCapacity()) throw terminalError('terminal_limit');

      let name;
      do { name = `web-${randomBytes(6).toString('hex')}`; } while (byName.has(name));
      const marker = runtimeMarker + randomBytes(16).toString('hex');
      const checked = assertStillInsideRoot(roots, resolved);
      if (!checked.ok) throw terminalError(checked.code);
      if (checked.absolutePath !== resolved.absolutePath) {
        throw terminalError('project_path_changed');
      }
      const result = service.tmux([
        ...service.startArgs(checked.absolutePath, name),
        '-P', '-F', '#{session_id}|#{pid}', ';', 'set-option', '-t', name, '@web-workspace-terminal', marker,
      ]);
      service.invalidateMetadata();
      const [sessionId, serverPid] = result.trim().split('|');
      const record = { name, sessionId, serverPid, marker, chatId, ownerId, active: true };
      byChat.set(chatId, record);
      byName.set(record.name, record);
      return record.name;
    },
    remove(ownerId, name) {
      const record = byName.get(name);
      if (!record) throw terminalError('not_found');
      if (record.ownerId !== ownerId) throw terminalError('forbidden');
      close(record);
    },
    async authorizeStop(req, chatId) {
      const record = byChat.get(chatId);
      if (record && record.ownerId !== await owner(req)) throw terminalError('forbidden');
    },
    async binding(req, name, marker) {
      const ownerId = await owner(req).catch(() => undefined);
      const record = byName.get(name);
      if (!record?.active || record.marker !== marker || record.ownerId !== ownerId) {
        throw terminalError('AUTHORITY_UNAVAILABLE');
      }
      return [record.sessionId, record.serverPid, marker];
    },
    closeChat,
    close() {
      for (const record of byName.values()) {
        try { close(record); } catch { /* Marked sessions stay inaccessible after shutdown. */ }
      }
    },
  };
}

function createWorkspace({ configPath, checkRequest, terminal: terminalService, spawnFn = spawn, gitRunner = runGit }) {
  let roots, managerRoots, workspacesRoot, codexHome, agents, claudeMcpConfigFile, projectPaths, allowedRepositories, historyFile;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    roots = loadProjectRoots(config);
    if (!path.isAbsolute(config.workspacesRoot)) throw new Error();
    const repositoryRefs = config.github?.repositories ?? [];
    if (!Array.isArray(repositoryRefs)) throw new Error();
    allowedRepositories = new Set(repositoryRefs.map(ref => {
      const parsed = github.parseGithubRepo(ref);
      if (!parsed.ok) throw new Error();
      return repositoryKey(parsed);
    }));
    agents = loadModelOptions(config.models);
    codexHome = config.codex?.home ?? path.join(homedir(), '.local/share/linux-web-terminal/codex');
    if (!path.isAbsolute(codexHome)) throw new Error();
    codexHome = path.resolve(codexHome);
    checkCodexHome(codexHome);
    fs.mkdirSync(config.workspacesRoot, { recursive: true, mode: 0o700 });
    workspacesRoot = fs.realpathSync(config.workspacesRoot);
    projectPaths = [...roots.map(root => root.realPath), workspacesRoot,
      ...config.roots.map(root => root.path), config.workspacesRoot];
    claudeMcpConfigFile = loadClaudeMcpFile(config.mcp, projectPaths);
    historyFile = typeof config.historyFile === 'string' && path.isAbsolute(config.historyFile)
      ? config.historyFile : path.join(workspacesRoot, '.session-history.json');
    managerRoots = loadProjectRoots({
      roots: [
        ...roots.map(({ id, label, realPath }) => ({ id, label, path: realPath })),
        { id: githubRootId, label: 'GitHub', path: workspacesRoot },
      ],
    });
  } catch {
    throw new Error('Workspace configuration unavailable');
  }

  let closing = false;
  const terminal = terminalService ? createWorkspaceTerminals({
    service: terminalService, roots: managerRoots, getProject: id => sessionManager.terminalProject(id),
  }) : undefined;
  const sessionManager = createSessionManager({
    roots: managerRoots,
    historyFile,
    agents,
    claudeMcpConfigFile,
    onDiscard: terminal?.closeChat,
    env: { CODEX_HOME: codexHome },
    spawnFn(agent, args, options) {
      if (closing) throw new Error('Workspace is shutting down');
      const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => agentEnvKey.test(key)));
      if (agent === 'claude') {
        delete env.CODEX_HOME;
        if (claudeMcpConfigFile && resolveClaudeMcpFile(claudeMcpConfigFile, projectPaths) !== claudeMcpConfigFile) {
          throw new Error('Invalid MCP configuration');
        }
        return spawnFn(agent, args, { ...options, env });
      }
      fs.mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });
      env.CODEX_HOME = fs.realpathSync(env.CODEX_HOME);
      checkCodexHome(env.CODEX_HOME);
      return spawnFn(agent, args, { ...options, env });
    },
  });
  const githubWorkspace = {
    rootId: githubRootId,
    workspacesRoot,
    runner: gitRunner,
    createWorkspace(options) {
      if (!allowedRepositories.has(repositoryKey(options.repo))) return { ok: false, code: 'repository_forbidden' };
      return github.createWorkspace(options);
    },
    cleanupWorkspace: github.cleanupWorkspace,
  };
  const handleRoutes = createWorkspaceRoutes({ roots, sessionManager, githubWorkspace, checkRequest, terminal, agents });
  const eventStreams = new Set();
  return {
    async handle(req, res) {
      if (closing) return false;
      if (req.method === 'GET' && /^\/api\/workspace\/sessions\/[^/]+\/events(?:\?|$)/.test(req.url)) {
        eventStreams.add(res);
        res.once('close', () => eventStreams.delete(res));
      }
      return handleRoutes(req, res);
    },
    terminalBinding: terminal?.binding,
    close() {
      closing = true;
      for (const res of eventStreams) res.destroy();
      for (const { sessionId } of sessionManager.list()) sessionManager.stop(sessionId);
      terminal?.close();
    },
  };
}

module.exports = { createWorkspace };
