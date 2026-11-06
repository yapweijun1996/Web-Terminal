'use strict';
// Experimental, same-UID private-server owner. Not a network authorization boundary.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
class WatcherOwner {
  constructor(dir, server) {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error('Unsafe private directory');
    if (!/^candidate_[a-f0-9]{12}$/.test(server)) throw Error('Invalid private server');
    this.dir = dir; this.server = server; this.leases = new Set(); this.state = 'NEW';
    this.lock = `${dir}/owner-${server}`;
    fs.mkdirSync(this.lock, { mode: 0o700 }); // Never auto-remove a stale owner lock.
  }
  tmux(...args) { return execFileSync('tmux', ['-L', this.server, '-f', '/dev/null', ...args], { env: { ...process.env, TMUX_TMPDIR: this.dir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim(); }
  start() {
    if (this.state !== 'NEW') throw Error('Invalid state');
    // Only create a new server; never adopt an existing one.
    try { this.tmux('has-session'); this.state = 'AMBIGUOUS'; throw Error('Server already exists'); } catch (e) { if (this.state === 'AMBIGUOUS') throw e; const message = String(e.stderr || ''); if (!/no server running|error connecting .*\(No such file or directory\)/i.test(message)) { this.state = 'AMBIGUOUS'; throw Error('Cannot establish server absence'); } }
    this.tmux('new-session', '-d', '-x', '80', '-y', '24', '-s', 'workspace', '/bin/cat');
    this.created = true;
    this.identity = this.tmux('display-message', '-p', '-t', '=workspace:', '#{pid}:#{session_id}:#{window_id}:#{pane_id}');
    if (!/^\d+:\$\d+:@\d+:%\d+$/.test(this.identity)) throw Error('Invalid identity');
    this.window = this.identity.split(':')[2];
    this.localPrior = this.tmux('show-window-options', '-t', this.window, 'window-size');
    this.prior = this.localPrior ? this.localPrior.slice('window-size '.length) : this.tmux('show-window-options', '-gv', 'window-size');
    if (!/^(latest|largest|smallest|manual)$/.test(this.prior) || (this.localPrior && this.localPrior !== `window-size ${this.prior}`)) throw Error('Invalid prior option');
    this.tmux('set-window-option', '-t', this.window, 'window-size', 'manual');
    this.state = 'ACTIVE'; this.verify();
  }
  verify() {
    if (this.state !== 'ACTIVE' || this.tmux('display-message', '-p', '-t', '=workspace:', '#{pid}:#{session_id}:#{window_id}:#{pane_id}') !== this.identity || this.tmux('show-window-options', '-v', '-t', this.window, 'window-size') !== 'manual') { this.state = 'AMBIGUOUS'; throw Error('Ownership or target changed'); }
  }
  acquire() { this.verify(); const token = randomBytes(24).toString('hex'); this.leases.add(token); return token; }
  release(token) { this.verify(); if (!this.leases.delete(token)) throw Error('Invalid lease'); }
  close() {
    this.verify(); if (this.leases.size) throw Error('Watchers remain');
    // This check is safe only under the exclusive same-UID owner contract: external
    // tmux option changes, including ABA changes, cannot be detected reliably.
    if (this.localPrior) this.tmux('set-window-option', '-t', this.window, 'window-size', this.prior);
    else this.tmux('set-window-option', '-u', '-t', this.window, 'window-size');
    if (this.tmux('show-window-options', '-t', this.window, 'window-size') !== this.localPrior) { this.state = 'AMBIGUOUS'; throw Error('Restore verification failed'); }
    this.state = 'RESTORED'; fs.rmdirSync(this.lock);
  }
}
module.exports = { WatcherOwner };
