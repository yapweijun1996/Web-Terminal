'use strict';

const { randomUUID, randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// This is an in-process authority, not an authentication or network boundary.
// Only a trusted adapter may create connections or supply the executor.
class InputBroker {
  constructor({ verifyTarget, execute, now = () => performance.now(), ttlMs = 15000 }) {
    if (typeof verifyTarget !== 'function' || typeof execute !== 'function' ||
        !Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 60000) throw Error('Invalid broker configuration');
    Object.assign(this, { verifyTarget, execute, now, ttlMs });
    this.epoch = randomUUID();
    this.generation = 0;
    this.connections = new Map();
    this.leases = new Map();
    this.queue = Promise.resolve();
  }
  serial(fn) {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
  // The adapter must have authenticated the principal and decided permissions.
  connect({ principal, write = false, takeover = false }) {
    if (typeof principal !== 'string' || !principal || principal.length > 256 ||
        typeof write !== 'boolean' || typeof takeover !== 'boolean') throw Error('Invalid principal');
    const connection = Object.freeze({});
    this.connections.set(connection, { principal, write, takeover });
    return connection;
  }
  targetKey(target) {
    if (!target || typeof target !== 'object' ||
        typeof target.serverPid !== 'string' || !/^\d{1,20}$/.test(target.serverPid) ||
        typeof target.sessionId !== 'string' || !/^\$\d{1,20}$/.test(target.sessionId) ||
        typeof target.windowId !== 'string' || !/^@\d{1,20}$/.test(target.windowId) ||
        typeof target.paneId !== 'string' || !/^%\d{1,20}$/.test(target.paneId)) throw Error('Invalid target');
    return `${target.serverPid}:${target.paneId}`;
  }
  snapshot(target) {
    this.targetKey(target);
    return Object.freeze({ serverPid: target.serverPid, sessionId: target.sessionId, windowId: target.windowId, paneId: target.paneId });
  }
  identity(target) { return [target.serverPid, target.sessionId, target.windowId, target.paneId].join(':'); }
  connection(connection, permission = 'write') {
    const record = this.connections.get(connection);
    if (!record || !record[permission]) throw Error('Permission denied');
    return record;
  }
  active(key) {
    const lease = this.leases.get(key);
    if (lease && lease.expires <= this.now()) { this.leases.delete(key); return null; }
    return lease || null;
  }
  claim(connection, target, { takeover = false } = {}) {
    return this.serial(async () => {
      const principal = this.connection(connection);
      target = this.snapshot(target);
      const key = this.targetKey(target);
      if (typeof takeover !== 'boolean') throw Error('Invalid takeover');
      await this.verifyTarget(target);
      this.connection(connection);
      const current = this.active(key);
      if (current && (!takeover || !principal.takeover)) throw Error('Lease held');
      if (takeover && !principal.takeover) throw Error('Permission denied');
      const lease = { connection, identity: this.identity(target), token: randomBytes(32).toString('hex'),
        generation: `${this.epoch}:${++this.generation}`, expires: this.now() + this.ttlMs };
      this.leases.set(key, lease);
      return { token: lease.token, generation: lease.generation, ttlMs: this.ttlMs };
    });
  }
  checked(connection, target, proof) {
    this.connection(connection);
    const lease = this.active(this.targetKey(target));
    if (!lease || lease.connection !== connection || lease.identity !== this.identity(target) ||
        !proof || proof.token !== lease.token || proof.generation !== lease.generation) throw Error('Lease unavailable');
    return lease;
  }
  renew(connection, target, proof) {
    return this.serial(async () => {
      target = this.snapshot(target);
      proof = proof && { token: proof.token, generation: proof.generation };
      this.checked(connection, target, proof);
      await this.verifyTarget(target);
      const lease = this.checked(connection, target, proof);
      lease.expires = this.now() + this.ttlMs;
      return { ttlMs: this.ttlMs };
    });
  }
  release(connection, target, proof) {
    return this.serial(() => { this.checked(connection, target, proof); this.leases.delete(this.targetKey(target)); });
  }
  mutate(connection, target, proof, operation) {
    return this.serial(async () => {
      target = this.snapshot(target);
      proof = proof && { token: proof.token, generation: proof.generation };
      operation = structuredClone(operation);
      this.checked(connection, target, proof);
      await this.verifyTarget(target);
      this.checked(connection, target, proof);
      // The executor must independently guard target identity in tmux's queue.
      return this.execute(target, operation);
    });
  }
  disconnect(connection) {
    // Invalidate immediately; queued work rechecks before executing.
    this.connections.delete(connection);
    return this.serial(() => {
      for (const [key, lease] of this.leases) if (lease.connection === connection) this.leases.delete(key);
    });
  }
}
module.exports = { InputBroker };
