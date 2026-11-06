// Process-local admission accounting. This is not a filesystem quota.
const GIB = 1024 ** 3;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw Error(`Invalid ${name}`);
  return value;
}

function configuredInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw Error(`Invalid ${name}`);
  return positiveInteger(Number(raw), name);
}

export class StorageReservations {
  constructor(options = {}) {
    this.budget = positiveInteger(options.budget ?? configuredInteger("WEB_TERMINAL_STORAGE_JOB_BUDGET_BYTES", GIB), "job budget");
    this.minimumReserve = positiveInteger(options.minimumReserve ?? configuredInteger("WEB_TERMINAL_STORAGE_MIN_RESERVE_BYTES", GIB), "minimum reserve");
    this.reserved = new Map();
  }

  // Sampling, verification and accounting are synchronous: no other admission can
  // interleave between the observation and reservation on this Node event loop.
  acquire(storage, registry, cwd) {
    let decision;
    try {
      decision = storage.decision(registry, cwd);
      if (!decision?.allowed) return { decision: decision ?? { allowed: false, state: "UNAVAILABLE" }, release: null };
      if (!storage.verify(decision)) return { decision: { ...decision, allowed: false, state: "UNAVAILABLE" }, release: null };
    } catch { return { decision: { allowed: false, state: "UNAVAILABLE" }, release: null }; }
    const volumes = new Map();
    for (const name of ["registry", "cwd"]) {
      const id = decision.identities?.[name]?.dev;
      const available = decision.volumes?.[name]?.available_bytes;
      if (typeof id !== "string" || !/^[0-9]+$/.test(id) || !Number.isSafeInteger(available) || available < 0) {
        return { decision: { ...decision, allowed: false, state: "UNAVAILABLE" }, release: null };
      }
      volumes.set(id, Math.min(volumes.get(id) ?? available, available));
    }
    const floor = decision.thresholds_bytes?.normal;
    if (!Number.isSafeInteger(floor) || floor <= 0) return { decision: { ...decision, allowed: false, state: "UNAVAILABLE" }, release: null };
    for (const [id, available] of volumes) {
      const required = BigInt(floor) + BigInt(this.minimumReserve) + BigInt(this.budget) + (this.reserved.get(id) ?? 0n);
      if (BigInt(available) < required) return { decision: { ...decision, allowed: false, state: "RESERVATION_EXHAUSTED" }, release: null };
    }
    for (const id of volumes.keys()) this.reserved.set(id, (this.reserved.get(id) ?? 0n) + BigInt(this.budget));
    let released = false;
    return { decision, release: () => {
      if (released) return;
      released = true;
      for (const id of volumes.keys()) {
        const remaining = this.reserved.get(id) - BigInt(this.budget);
        if (remaining) this.reserved.set(id, remaining); else this.reserved.delete(id);
      }
    } };
  }
}

// One pool per service process; callers may inject a pool for isolated tests.
export const storageReservations = new StorageReservations();
