import fs from "node:fs";
import path from "node:path";

const GIB = 1024 ** 3;
const defaults = { normal: 60 * GIB, warning: 40 * GIB, critical: 25 * GIB };
export function pathIdentity(target, allowMissing = false) {
  let p = target;
  for (;;) {
    try {
      const canonical = fs.realpathSync(p);
      const stat = fs.statSync(canonical, { bigint: true });
      if (!stat.isDirectory()) throw Error("invalid directory");
      return { target, canonical, dev: String(stat.dev), ino: String(stat.ino), allowMissing };
    } catch (e) {
      if (!allowMissing || e.code !== "ENOENT" || path.dirname(p) === p) throw e;
      p = path.dirname(p);
    }
  }
}
export function sameIdentity(identity) {
  try {
    const current = pathIdentity(identity.target, identity.allowMissing);
    return current.canonical === identity.canonical && current.dev === identity.dev && current.ino === identity.ino;
  } catch { return false; }
}
const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw Error(`Invalid ${name}`);
  return Number(raw);
};

export class StorageSafety {
  constructor(options = {}) {
    this.thresholds = options.thresholds ?? {
      normal: envNumber("WEB_TERMINAL_STORAGE_NORMAL_BYTES", defaults.normal),
      warning: envNumber("WEB_TERMINAL_STORAGE_WARNING_BYTES", defaults.warning),
      critical: envNumber("WEB_TERMINAL_STORAGE_CRITICAL_BYTES", defaults.critical),
    };
    const { normal, warning, critical } = this.thresholds;
    if (![normal, warning, critical].every(n => Number.isSafeInteger(n) && n > 0) || !(normal > warning && warning > critical)) throw Error("Invalid storage thresholds");
    this.intervalMs = options.intervalMs ?? envNumber("WEB_TERMINAL_STORAGE_INTERVAL_MS", 300000);
    this.maxAgeMs = options.maxAgeMs ?? this.intervalMs * 2;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1000 || this.intervalMs > 86400000 || !Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1000 || this.maxAgeMs > 172800000) throw Error("Invalid storage interval");
    this.statfs = options.statfs ?? ((p) => fs.statfsSync(p, { bigint: true }));
    this.clock = options.clock ?? Date.now;
    this.snapshots = new Map();
    this.timer = null;
    this.lastTime = null;
  }
  now() {
    try {
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0 || (this.lastTime !== null && now < this.lastTime)) return null;
      this.lastTime = now;
      return now;
    } catch { return null; }
  }
  sample(target, allowMissing = false) {
    try {
      const identity = pathIdentity(target, allowMissing);
      const stat = this.statfs(identity.canonical);
      const integer = value => {
        if (typeof value === "bigint") return value;
        if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
        throw Error("invalid metric");
      };
      const bsize = integer(stat.bsize), bavail = integer(stat.bavail);
      if (bsize <= 0n || bavail < 0n) throw Error("invalid metric");
      const bytes = bsize * bavail;
      if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("invalid metric");
      const available = Number(bytes), sampledAt = this.now();
      if (sampledAt === null || !sameIdentity(identity)) throw Error("invalid clock or path changed");
      const state = available >= this.thresholds.normal ? "NORMAL" : available >= this.thresholds.warning ? "WARNING" : available >= this.thresholds.critical ? "CRITICAL" : "EMERGENCY";
      return { state, available_bytes: available, sampled_at_ms: sampledAt, identity };
    } catch { return { state: "UNAVAILABLE", available_bytes: null, sampled_at_ms: null }; }
  }
  decision(registry, cwd) {
    const volumes = { registry: this.sample(registry, true), cwd: this.sample(cwd) };
    const now = this.now();
    for (const metric of Object.values(volumes)) {
      if (now === null || metric.sampled_at_ms === null || now < metric.sampled_at_ms || now - metric.sampled_at_ms > this.maxAgeMs || !sameIdentity(metric.identity)) metric.state = "UNAVAILABLE";
    }
    const states = Object.values(volumes).map(v => v.state);
    const state = ["UNAVAILABLE", "EMERGENCY", "CRITICAL", "WARNING", "NORMAL"].find(s => states.includes(s));
    const allowed = state === "NORMAL";
    const identities = { registry: volumes.registry.identity, cwd: volumes.cwd.identity };
    for (const metric of Object.values(volumes)) delete metric.identity;
    const decision = { allowed, state, thresholds_bytes: { ...this.thresholds }, volumes };
    Object.defineProperty(decision, "identities", { value: identities });
    return decision;
  }
  verify(decision) { return !!decision?.allowed && sameIdentity(decision.identities?.registry) && sameIdentity(decision.identities?.cwd); }
  start(registry, active) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const next = new Map();
      for (const [id, cwd] of active()) next.set(id, this.decision(registry, cwd));
      this.snapshots = next;
    }, this.intervalMs);
    this.timer.unref?.();
  }
  snapshot(id) {
    const result = this.snapshots.get(id);
    if (!result) return null;
    const now = this.now();
    if (!Number.isSafeInteger(now) || Object.values(result.volumes).some(v => v.sampled_at_ms === null || now < v.sampled_at_ms || now - v.sampled_at_ms > this.maxAgeMs)) return { ...result, state: "UNAVAILABLE", allowed: false };
    return result;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.snapshots.clear(); }
}
