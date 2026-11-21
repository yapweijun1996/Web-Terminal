'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadProjectRoots, listProjects, resolveProjectPath, assertStillInsideRoot,
} = require('../workspace/project-roots');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-project-roots-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'projects');
  const outside = path.join(temp, 'projects-other');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const entry = { id: 'work', label: 'Work', path: root };
  return { temp, root, outside, entry, roots: loadProjectRoots({ roots: [entry] }) };
}

test('rejects an absolute project path', t => {
  const { roots, root } = fixture(t);
  assert.deepEqual(resolveProjectPath(roots, 'work', root), { ok: false, code: 'invalid_path' });
});

test('rejects a leading parent traversal', t => {
  const { roots } = fixture(t);
  assert.deepEqual(resolveProjectPath(roots, 'work', '../'), { ok: false, code: 'invalid_path' });
});

test('rejects a parent traversal after a directory', t => {
  const { roots } = fixture(t);
  assert.deepEqual(resolveProjectPath(roots, 'work', 'a/../../x'), { ok: false, code: 'invalid_path' });
});

test('rejects backslashes, NUL, and empty path segments', t => {
  const { roots } = fixture(t);
  for (const invalid of ['a\\b', 'a\0b', '', 'a//b', 'a/']) {
    assert.deepEqual(resolveProjectPath(roots, 'work', invalid), { ok: false, code: 'invalid_path' });
  }
});

test('distinguishes missing projects from regular files', t => {
  const { roots, root } = fixture(t);
  fs.writeFileSync(path.join(root, 'file'), '');
  assert.deepEqual(resolveProjectPath(roots, 'work', 'missing'), { ok: false, code: 'not_found' });
  assert.deepEqual(resolveProjectPath(roots, 'work', 'file'), { ok: false, code: 'not_directory' });
  assert.deepEqual(resolveProjectPath(roots, 'work', 'file/child'), { ok: false, code: 'not_directory' });
});

test('rejects a symlink to a directory outside the root with a shared path prefix', t => {
  const { roots, root, outside } = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.deepEqual(resolveProjectPath(roots, 'work', 'escape'), { ok: false, code: 'outside_root' });
});

test('resolves an internal symlink to a canonical path and revalidates it', t => {
  const { roots, root } = fixture(t);
  const project = path.join(root, 'group', 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.symlinkSync('group', path.join(root, 'alias'));
  const resolved = resolveProjectPath(roots, 'work', 'alias/project');
  assert.deepEqual(resolved, {
    ok: true, rootId: 'work', relPath: 'alias/project', absolutePath: fs.realpathSync.native(project),
  });
  assert.deepEqual(assertStillInsideRoot(roots, resolved), resolved);
});

test('rejects a project directory swapped for an outside symlink after resolution', t => {
  const { roots, root, outside } = fixture(t);
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const resolved = resolveProjectPath(roots, 'work', 'project');
  assert.equal(resolved.ok, true);
  fs.renameSync(project, path.join(root, 'old-project'));
  fs.symlinkSync(outside, project);
  assert.deepEqual(assertStillInsideRoot(roots, resolved), { ok: false, code: 'outside_root' });
});

test('revalidation follows the original alias even if its former target still exists', t => {
  const { roots, root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, 'project'));
  const alias = path.join(root, 'alias');
  fs.symlinkSync('project', alias);
  const resolved = resolveProjectPath(roots, 'work', 'alias');
  assert.equal(resolved.ok, true);
  fs.unlinkSync(alias);
  fs.symlinkSync(outside, alias);
  assert.deepEqual(assertStillInsideRoot(roots, resolved), { ok: false, code: 'outside_root' });
});

test('lists only sorted, visible, immediate directories and internal directory symlinks', t => {
  const { roots, root, outside } = fixture(t);
  fs.mkdirSync(path.join(root, 'zeta', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'alpha'));
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, 'file'), '');
  fs.symlinkSync('alpha', path.join(root, 'alias'));
  fs.symlinkSync('file', path.join(root, 'file-alias'));
  fs.symlinkSync('missing', path.join(root, 'broken'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.deepEqual(listProjects(roots, 'work'), ['alias', 'alpha', 'zeta']);
});

test('loads canonical roots and freezes both the array and its entries', t => {
  const { temp, root, entry } = fixture(t);
  const alias = path.join(temp, 'alias');
  fs.symlinkSync(root, alias);
  const roots = loadProjectRoots({ roots: [{ ...entry, path: alias }] });
  assert.deepEqual(roots, [{ id: 'work', label: 'Work', realPath: fs.realpathSync.native(root) }]);
  assert.equal(Object.isFrozen(roots), true);
  assert.equal(Object.isFrozen(roots[0]), true);
});

test('rejects invalid root configuration with an error code', t => {
  const { entry, root } = fixture(t);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, '');
  for (const invalid of [
    {}, { roots: [null] }, { roots: [{ ...entry, id: 'Work' }] },
    { roots: [{ ...entry, label: 1 }] }, { roots: [{ ...entry, path: 'relative' }] },
    { roots: [{ ...entry, path: path.join(root, 'missing') }] }, { roots: [{ ...entry, path: file }] },
  ]) {
    assert.throws(() => loadProjectRoots(invalid), { code: 'invalid_config' });
  }
});

test('rejects duplicate root IDs', t => {
  const { entry, outside } = fixture(t);
  assert.throws(() => loadProjectRoots({ roots: [entry, { ...entry, path: outside }] }), {
    code: 'duplicate_root',
  });
});

test('rejects nested roots in either order after canonicalization', t => {
  const { temp, entry, root } = fixture(t);
  const child = path.join(root, 'child');
  fs.mkdirSync(child);
  const alias = path.join(temp, 'alias');
  fs.symlinkSync(child, alias);
  const nested = { id: 'nested', label: 'Nested', path: alias };
  for (const roots of [[entry, nested], [nested, entry]]) {
    assert.throws(() => loadProjectRoots({ roots }), { code: 'nested_roots' });
  }
});

test('rejects unknown root IDs', t => {
  const { roots } = fixture(t);
  assert.deepEqual(resolveProjectPath(roots, 'unknown', 'project'), { ok: false, code: 'unknown_root' });
  assert.deepEqual(listProjects(roots, 'unknown'), []);
});
