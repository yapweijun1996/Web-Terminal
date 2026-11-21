'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rootIdPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

function configError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isInsideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function loadProjectRoots(config) {
  if (!Array.isArray(config?.roots)) {
    throw configError('invalid_config', 'Project roots must be an array');
  }

  const roots = [];
  for (const entry of config.roots) {
    const { id, label, path: configuredPath } = entry ?? {};
    if (typeof id !== 'string' || !rootIdPattern.test(id) || typeof label !== 'string' ||
        typeof configuredPath !== 'string' || !path.isAbsolute(configuredPath)) {
      throw configError('invalid_config', 'Each project root needs a valid ID, label, and absolute path');
    }
    if (roots.some(root => root.id === id)) {
      throw configError('duplicate_root', `Duplicate project root ID: ${id}`);
    }

    let realPath;
    let isDirectory;
    try {
      realPath = fs.realpathSync.native(configuredPath);
      isDirectory = fs.statSync(realPath).isDirectory();
    } catch {
      throw configError('invalid_config', `Cannot resolve project root: ${id}`);
    }
    if (!isDirectory) {
      throw configError('invalid_config', `Project root must be a directory: ${id}`);
    }
    if (roots.some(root => isInsideRoot(root.realPath, realPath) || isInsideRoot(realPath, root.realPath))) {
      throw configError('nested_roots', `Project root overlaps another root: ${id}`);
    }
    roots.push(Object.freeze({ id, label, realPath }));
  }
  return Object.freeze(roots);
}

function resolveProjectPath(roots, rootId, relPath) {
  const root = roots.find(entry => entry.id === rootId);
  if (!root) return { ok: false, code: 'unknown_root' };
  if (typeof relPath !== 'string' || path.isAbsolute(relPath) || /[\\\0]/.test(relPath) ||
      relPath.split('/').some(segment => segment === '' || segment === '..')) {
    return { ok: false, code: 'invalid_path' };
  }

  const separator = root.realPath.endsWith(path.sep) ? '' : path.sep;
  try {
    const absolutePath = fs.realpathSync.native(`${root.realPath}${separator}${relPath}`);
    if (!isInsideRoot(root.realPath, absolutePath)) return { ok: false, code: 'outside_root' };
    if (!fs.statSync(absolutePath).isDirectory()) return { ok: false, code: 'not_directory' };
    return { ok: true, rootId, relPath, absolutePath };
  } catch (error) {
    return { ok: false, code: error.code === 'ENOTDIR' ? 'not_directory' : 'not_found' };
  }
}

function listProjects(roots, rootId) {
  const root = roots.find(entry => entry.id === rootId);
  if (!root) return [];

  let names;
  try {
    names = fs.readdirSync(root.realPath);
  } catch {
    return [];
  }
  return names.filter(name => !name.startsWith('.') && resolveProjectPath(roots, rootId, name).ok).sort();
}

function assertStillInsideRoot(roots, resolved) {
  // Revisit the original path because a symlink can change after resolution.
  return resolveProjectPath(roots, resolved.rootId, resolved.relPath);
}

module.exports = { loadProjectRoots, listProjects, resolveProjectPath, assertStillInsideRoot };
