'use strict';
// Scratch-only, process-bound candidate. No tmux, external paths or recovery API.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const C = fs.constants;
function checkDir(dir) {
  if (!path.isAbsolute(dir) || path.resolve(dir) !== dir || path.dirname(dir) !== fs.realpathSync(os.tmpdir()) || !path.basename(dir).startsWith('staging-')) throw Error('invalid scratch directory');
  // Do not accept symlink ancestors, including the final directory.
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || !st.isDirectory()) throw Error('unsafe directory');
  }
  const st = fs.lstatSync(dir);
  if (st.uid !== process.geteuid() || (st.mode & 0o7777) !== 0o700) throw Error('directory must be private and owned');
}
function syncDir(dir) {
  let fd;
  try { fd = fs.openSync(dir, C.O_RDONLY); fs.fsyncSync(fd); }
  catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readFileSafe(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.geteuid() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1) throw Error('unsafe file');
  const fd = fs.openSync(file, C.O_RDONLY | (C.O_NOFOLLOW || 0));
  try { const actual = fs.fstatSync(fd); if (actual.ino !== st.ino || actual.dev !== st.dev) throw Error('file changed'); return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
}
function writeNew(file, data) {
  const fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | (C.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function open(dir) {
  checkDir(dir);
  const marker = path.join(dir, 'fence');
  const journal = path.join(dir, 'journal');
  const output = path.join(dir, 'output');
  // A permanent O_EXCL fence rejects concurrent takeover and all automatic re-entry.
  // A failure at any later step also leaves the fence, hence fails closed.
  try { writeNew(marker, 'FENCED\n'); syncDir(dir); }
  catch (e) { if (e.code === 'EEXIST') return { status: 'QUARANTINED' }; throw e; }
  if (fs.readdirSync(dir).some(name => name !== 'fence')) throw Error('directory not empty');
  const generation = crypto.randomBytes(32).toString('hex');
  const state = JSON.stringify({ version: 1, state: 'ACTIVE', generation, pid: process.pid });
  const tmp = path.join(dir, `.journal-${crypto.randomBytes(16).toString('hex')}`);
  writeNew(tmp, state); fs.renameSync(tmp, journal); syncDir(dir);
  writeNew(output, ''); syncDir(dir);
  const ownerPid = process.pid;
  function validate(lease) {
    checkDir(dir);
    if (process.pid !== ownerPid || lease !== generation || readFileSafe(marker) !== 'FENCED\n') throw Error('fenced');
    let actual;
    try { actual = JSON.parse(readFileSafe(journal)); } catch { throw Error('corrupt journal'); }
    if (!actual || Object.keys(actual).sort().join(',') !== 'generation,pid,state,version' || actual.version !== 1 || actual.state !== 'ACTIVE' || actual.generation !== generation || actual.pid !== ownerPid) throw Error('stale or corrupt journal');
  }
  return { status: 'ACTIVE', lease: generation, write(lease, data) {
    validate(lease);
    const st = fs.lstatSync(output);
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.geteuid() || st.nlink !== 1 || (st.mode & 0o7777) !== 0o600) throw Error('unsafe output');
    const fd = fs.openSync(output, C.O_WRONLY | C.O_APPEND | (C.O_NOFOLLOW || 0));
    try { const actual = fs.fstatSync(fd); if (actual.ino !== st.ino || actual.dev !== st.dev) throw Error('file changed'); fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }, renew(lease) { validate(lease); return generation; } };
}
module.exports = { open };
