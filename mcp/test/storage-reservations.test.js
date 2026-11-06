import test from "node:test";
import assert from "node:assert/strict";
import { StorageReservations } from "../storage-reservations.js";

function storage(registryDevice = "1", cwdDevice = "1", registryFree = 130, cwdFree = 130) {
  return {
    decision: () => ({ allowed: true, state: "NORMAL", thresholds_bytes: { normal: 100 },
      identities: { registry: { dev: registryDevice }, cwd: { dev: cwdDevice } },
      volumes: { registry: { available_bytes: registryFree }, cwd: { available_bytes: cwdFree } } }),
    verify: () => true,
  };
}

test("admission accounts atomically at the budget boundary and release is idempotent", async () => {
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const attempts = await Promise.all(Array.from({ length: 3 }, async () => reservations.acquire(storage(), "/r", "/c")));
  assert.deepEqual(attempts.map(a => a.decision.allowed), [true, true, false]);
  assert.equal(attempts[2].decision.state, "RESERVATION_EXHAUSTED");
  attempts[0].release(); attempts[0].release();
  assert.equal(reservations.acquire(storage(), "/r", "/c").decision.allowed, true);
  assert.equal(reservations.acquire(storage(), "/r", "/c").decision.allowed, false);
});

test("both volumes are charged independently and the lower same-device sample governs", () => {
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const first = reservations.acquire(storage("1", "2", 120, 120), "/r", "/c");
  assert.equal(first.decision.allowed, true);
  assert.equal(reservations.acquire(storage("3", "2", 120, 120), "/r", "/c").decision.allowed, false);
  assert.equal(reservations.acquire(storage("3", "4", 120, 120), "/r", "/c").decision.allowed, true);
  first.release();
  assert.equal(reservations.acquire(storage("1", "1", 150, 119), "/r", "/c").decision.allowed, false);
});

test("invalid configuration, metrics, verification and sampler failure fail closed", () => {
  for (const budget of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new StorageReservations({ budget, minimumReserve: 1 }));
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const bad = storage(); bad.verify = () => false;
  assert.equal(reservations.acquire(bad, "/r", "/c").decision.state, "UNAVAILABLE");
  bad.decision = () => { throw Error("unavailable"); };
  assert.equal(reservations.acquire(bad, "/r", "/c").decision.state, "UNAVAILABLE");
  assert.equal(reservations.acquire(storage("invalid"), "/r", "/c").decision.state, "UNAVAILABLE");
  assert.equal(reservations.acquire(storage("1", "2", NaN), "/r", "/c").decision.state, "UNAVAILABLE");
});
