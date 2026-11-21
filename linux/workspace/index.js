'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { buildClaudeArgs } = require('./claude-adapter');
const github = require('./github-workspace');
const { loadProjectRoots } = require('./project-roots');
const { createSessionManager } = require('./session-manager');
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

function createWorkspace({ configPath, checkRequest, spawnFn = spawn, gitRunner = runGit }) {
  let roots, managerRoots, workspacesRoot, codexHome, claudeModelArgs, allowedRepositories, historyFile;
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
    const { model } = config.claude ?? {};
    claudeModelArgs = model === undefined ? [] : buildClaudeArgs({ model }).slice(buildClaudeArgs().length);
    codexHome = config.codex?.home ?? path.join(homedir(), '.local/share/linux-web-terminal/codex');
    if (!path.isAbsolute(codexHome)) throw new Error();
    codexHome = path.resolve(codexHome);
    checkCodexHome(codexHome);
    fs.mkdirSync(config.workspacesRoot, { recursive: true, mode: 0o700 });
    workspacesRoot = fs.realpathSync(config.workspacesRoot);
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
  const sessionManager = createSessionManager({
    roots: managerRoots,
    historyFile,
    env: { CODEX_HOME: codexHome },
    spawnFn(agent, args, options) {
      if (closing) throw new Error('Workspace is shutting down');
      const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => agentEnvKey.test(key)));
      if (agent === 'claude') {
        delete env.CODEX_HOME;
        // The session manager already appends the Claude isolation flags.
        return spawnFn(agent, [...args, ...claudeModelArgs], { ...options, env });
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
  const handleRoutes = createWorkspaceRoutes({ roots, sessionManager, githubWorkspace, checkRequest });
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
    close() {
      closing = true;
      for (const res of eventStreams) res.destroy();
      for (const { sessionId } of sessionManager.list()) sessionManager.stop(sessionId);
    },
  };
}

module.exports = { createWorkspace };
