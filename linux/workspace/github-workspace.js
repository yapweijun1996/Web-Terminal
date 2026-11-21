'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ownerPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/;
const repoInputPattern = /^(?:https:\/\/github\.com\/)?([^/]+)\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
const sessionPattern = /^[a-z0-9][a-z0-9-]{7,63}$/;
const cloneTimeoutMs = 120_000;
const statusTimeoutMs = 10_000;

function githubRepo(owner, repo) {
  if (typeof owner !== 'string' || !ownerPattern.test(owner) ||
      typeof repo !== 'string' || !repoPattern.test(repo) || repo === '.' || repo === '..') {
    return { ok: false, code: 'invalid_repo' };
  }
  return { ok: true, owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

function parseGithubRepo(input) {
  const match = typeof input === 'string' && repoInputPattern.exec(input);
  return match ? githubRepo(match[1], match[2]) : { ok: false, code: 'invalid_repo' };
}

function normalizeRepo(repo) {
  return repo && typeof repo === 'object' ? githubRepo(repo.owner, repo.repo) : parseGithubRepo(repo);
}

function workspacePathFor(workspacesRoot, repo, sessionId) {
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)) {
    throw Object.assign(new Error('Invalid workspace session ID'), { code: 'invalid_session' });
  }
  const parsed = normalizeRepo(repo);
  if (!parsed.ok) {
    throw Object.assign(new Error('Invalid GitHub repository'), { code: parsed.code });
  }
  return path.join(workspacesRoot, parsed.owner, parsed.repo, sessionId);
}

function redact(text) {
  return String(text ?? '')
    .replace(/(authorization[ \t]*:[ \t]*)[^\r\n]*/gi, '$1[REDACTED]')
    .replace(/(https:\/\/)[^\s/?#]+@/gi, '$1[REDACTED]@')
    .replace(/(?:ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_-]+/gi, '[REDACTED]');
}

function failure(code, message) {
  return { ok: false, code, message: redact(message) };
}

function gitEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0'
  };
}

function outsideWorkspaces() {
  return Object.assign(new Error('Workspace path is outside the workspace root'), { code: 'outside_workspaces' });
}

function resolveWorkspace(workspacesRoot, targetPath, createParents = false) {
  workspacesRoot = path.resolve(workspacesRoot);
  const relative = path.relative(workspacesRoot, targetPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw outsideWorkspaces();
  }

  if (createParents) fs.mkdirSync(workspacesRoot, { recursive: true, mode: 0o700 });
  let directory = fs.realpathSync(workspacesRoot);
  const segments = relative.split(path.sep);
  const finalSegment = segments.pop();
  for (const segment of segments) {
    directory = path.join(directory, segment);
    if (createParents) {
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    if (!fs.lstatSync(directory).isDirectory()) throw outsideWorkspaces();
  }
  return path.join(directory, finalSegment);
}

async function createWorkspace({ workspacesRoot, repo, sessionId, runner }) {
  const parsed = normalizeRepo(repo);
  if (!parsed.ok) return failure(parsed.code, 'Invalid GitHub repository');

  let workspacePath, target, reservation;
  try {
    workspacePath = workspacePathFor(workspacesRoot, parsed, sessionId);
    target = resolveWorkspace(workspacesRoot, workspacePath, true);
    // Git accepts an existing empty destination. mkdir reserves it before the first await.
    fs.mkdirSync(target, { mode: 0o700 });
    reservation = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'EEXIST') return failure('workspace_exists', 'Workspace path already exists');
    if (error.code === 'invalid_session' || error.code === 'outside_workspaces') {
      return failure(error.code, error.message);
    }
    return failure('clone_failed', 'Could not prepare the workspace directory');
  }

  let message = 'Git clone failed';
  try {
    const result = await runner('git', ['clone', '--depth', '1', '--', parsed.cloneUrl, workspacePath], {
      env: gitEnvironment(),
      timeoutMs: cloneTimeoutMs
    });
    if (result.code === 0) return { ok: true, path: workspacePath };
    if (result.stderr) message = result.stderr;
  } catch {
    // A runner exception may include its entire invocation or environment.
  }
  try {
    if (sameWorkspace(workspacesRoot, workspacePath, target, reservation)) fs.rmdirSync(target);
  } catch {
    // Preserve a nonempty destination for safe inspection.
  }
  return failure('clone_failed', message);
}

function sameWorkspace(workspacesRoot, workspacePath, target, originalStat) {
  if (resolveWorkspace(workspacesRoot, workspacePath) !== target) return false;
  const currentStat = fs.lstatSync(target);
  return currentStat.isDirectory() && currentStat.dev === originalStat.dev && currentStat.ino === originalStat.ino;
}

async function cleanupWorkspace({ workspacesRoot, path: workspacePath, runner }) {
  let target, originalStat;
  try {
    target = resolveWorkspace(workspacesRoot, workspacePath);
    originalStat = fs.lstatSync(target);
    if (!originalStat.isDirectory()) throw outsideWorkspaces();
  } catch {
    return failure('outside_workspaces', 'Workspace path is outside the workspace root or is not a directory');
  }

  try {
    const result = await runner('git', ['status', '--porcelain'], {
      cwd: target,
      env: {
        ...gitEnvironment(),
        GIT_CEILING_DIRECTORIES: path.dirname(target),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
        GIT_CONFIG_VALUE_0: 'all'
      },
      timeoutMs: statusTimeoutMs
    });
    if (result.code !== 0 || result.stdout !== '') {
      return failure('dirty', 'Workspace is dirty or Git could not verify its status');
    }
  } catch {
    return failure('dirty', 'Git could not verify workspace status');
  }

  try {
    if (!sameWorkspace(workspacesRoot, workspacePath, target, originalStat)) throw outsideWorkspaces();
  } catch {
    return failure('outside_workspaces', 'Workspace path changed during the Git status check');
  }
  try {
    fs.rmSync(target, { recursive: true });
  } catch {
    return failure('cleanup_failed', 'Could not remove the workspace directory');
  }
  return { ok: true };
}

module.exports = { parseGithubRepo, workspacePathFor, redact, createWorkspace, cleanupWorkspace };
