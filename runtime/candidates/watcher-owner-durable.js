'use strict';
// Quarantine candidate only. A same-UID process can tamper with every boundary here.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { WatcherOwner } = require('./watcher-owner');

function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
class DurableWatcherOwner {
  constructor(dir, server) {
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || dirStat.uid !== process.getuid() || (dirStat.mode & 0o777) !== 0o700) throw Error('Unsafe private directory');
    this.owner = new WatcherOwner(dir, server);
    syncDir(dir);
    this.dir = dir; this.lock = this.owner.lock; this.journal = path.join(this.lock, 'journal.json');
    const lockStat = fs.lstatSync(this.lock);
    this.lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
    this.state = 'NEW'; this.decision = 'NEEDS_OPERATOR';
    this.record = { version: 1, server, lock: this.lockIdentity, owner: { pid: process.pid, startIdentity: null }, target: null, lifecycle: 'NEW', option: null, leases: [], generation: 0, recoveryDecision: this.decision };
    this.write();
  }
  check() {
    const lock = fs.lstatSync(this.lock);
    if (!lock.isDirectory() || lock.isSymbolicLink() || lock.uid !== process.getuid() || (lock.mode & 0o077) || lock.dev !== this.lockIdentity.dev || lock.ino !== this.lockIdentity.ino) throw Error('Unsafe or changed lock');
    const fd = fs.openSync(this.journal, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 1024 * 1024 || fs.readFileSync(fd, 'utf8') !== this.snapshot) throw Error('Journal changed');
    } finally { fs.closeSync(fd); }
  }
  write() {
    if (this.snapshot !== undefined) this.check();
    const value = JSON.stringify(this.record);
    const tmp = path.join(this.lock, `.journal-${randomBytes(16).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      if (this.snapshot !== undefined) this.check();
      fs.renameSync(tmp, this.journal); syncDir(this.lock); this.snapshot = value;
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  save(lifecycle) { this.record.lifecycle = lifecycle; this.record.generation++; this.write(); this.state = lifecycle; }
  start() {
    this.check();
    try {
      this.save('STARTING'); this.owner.start();
      const [serverPid, session, window, pane] = this.owner.identity.split(':');
      this.record.target = { serverPid: Number(serverPid), session, window, pane };
      this.record.option = { beforeLocal: this.owner.localPrior, beforeEffective: this.owner.prior, after: 'manual' };
      this.save('ACTIVE');
    } catch (e) { this.state = 'AMBIGUOUS'; throw e; }
  }
  acquire(pid) {
    this.check(); this.owner.verify();
    if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid watcher PID');
    const token = this.owner.acquire();
    this.record.leases.push({ id: createHash('sha256').update(token).digest('hex'), pid, startIdentity: null });
    this.save('ACTIVE'); return token;
  }
  release(token) {
    this.check();
    try { this.owner.release(token); } catch (e) { this.state = 'AMBIGUOUS'; throw e; }
    const id = createHash('sha256').update(token).digest('hex');
    this.record.leases = this.record.leases.filter(lease => lease.id !== id); this.save('ACTIVE');
  }
  close() { this.check(); if (this.owner.leases.size) throw Error('Watchers remain'); throw Error('NEEDS_OPERATOR: restoration is quarantined'); }
  static recover() { throw Error('NEEDS_OPERATOR: recovery and lease reentry are quarantined'); }
}
module.exports = { DurableWatcherOwner };
