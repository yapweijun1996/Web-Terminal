import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StorageSafety } from "../storage-safety.js";
import { JobManager } from "../jobs.js";
import { terminalExec } from "../exec.js";

const G = 1024 ** 3;
const make = (statfs, options = {}) => new StorageSafety({ statfs, clock: () => 10000, ...options });

test("boundaries, classifications, and most restrictive volume win", () => {
  for (const [gb, state] of [[60,"NORMAL"],[59,"WARNING"],[40,"WARNING"],[39,"CRITICAL"],[25,"CRITICAL"],[24,"EMERGENCY"],[0,"EMERGENCY"]]) {
    const monitor = make(() => ({ bsize: 1n, bavail: BigInt(gb * G) }));
    for (const type of ["unknown", "heavy", "light"]) {
      const d = monitor.decision(os.tmpdir(), os.tmpdir(), type);
      assert.equal(d.state, state);
      assert.equal(d.allowed, state === "NORMAL");
    }
  }
  const monitor = make(p => ({ bsize: 1, bavail: p === fs.realpathSync(os.tmpdir()) ? 70 * G : 20 * G }));
  assert.equal(monitor.decision(os.tmpdir(), process.cwd(), "light").state, "EMERGENCY");
});

test("concurrent admission denies both tools without side effects under pressure", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-pressure-"));
  const dir = path.join(root, "jobs"), marker = path.join(root, "marker");
  const storage = make(() => ({ bsize: 1, bavail: 24 * G }));
  const manager = new JobManager(dir, { storage });
  t.after(() => { manager.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const input = { executable: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'bad')", marker], cwd: root };
  const results = await Promise.all(Array.from({ length: 4 }, () => [terminalExec(input, { storage, registry: dir }), manager.start({ ...input, storage_class: "light" })]).flat());
  for (const result of results) assert.equal(result.error.code, "STORAGE_ADMISSION_DENIED");
  assert.equal(fs.existsSync(marker), false); assert.equal(fs.existsSync(dir), false);
});

test("real statfs reports a bounded observation on a disposable directory", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-real-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metric = new StorageSafety().sample(root);
  assert.notEqual(metric.state, "UNAVAILABLE");
  assert.ok(Number.isSafeInteger(metric.available_bytes));
});

test("forged light, clock failures, path retarget and identity drift fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-adversarial-"));
  try {
    const a = path.join(root, "a"), b = path.join(root, "b"), link = path.join(root, "link");
    fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, link);
    const critical = make(() => ({ bsize: 1, bavail: 30 * G }));
    assert.equal(critical.decision(root, a, "light").allowed, false);
    for (const clock of [() => { throw Error("secret"); }, () => Infinity, (() => { let n = 10; return () => n--; })()]) {
      assert.equal(make(() => ({ bsize: 1, bavail: 70 * G }), { clock }).decision(root, a).state, "UNAVAILABLE");
    }
    const retarget = make(p => { if (p === fs.realpathSync(a)) { fs.unlinkSync(link); fs.symlinkSync(b, link); } return { bsize: 1, bavail: 70 * G }; });
    assert.equal(retarget.decision(root, link).state, "UNAVAILABLE");
    const normal = make(() => ({ bsize: 1, bavail: 70 * G }));
    const decision = normal.decision(root, link);
    fs.unlinkSync(link); fs.symlinkSync(a, link);
    assert.equal(normal.verify(decision), false);
    decision.identities.cwd.dev = "different-device";
    assert.equal(normal.verify(decision), false);
    assert.equal(make(() => { throw Error("secret"); }).decision(root, a).state, "UNAVAILABLE");
    const precedence = make(p => { if (p === fs.realpathSync(a)) throw Error("unavailable"); return { bsize: 1, bavail: 24 * G }; });
    assert.equal(precedence.decision(root, a).state, "UNAVAILABLE");
    const originalStat = fs.statSync;
    let calls = 0;
    try {
      fs.statSync = (p, options) => {
        const stat = originalStat(p, options);
        if (p === fs.realpathSync(a) && ++calls > 1) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1n });
        return stat;
      };
      assert.equal(normal.decision(root, a).state, "UNAVAILABLE");
    } finally { fs.statSync = originalStat; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("invalid metrics, errors, path resolution, and stale clocks fail closed", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, "link"); fs.symlinkSync(root, link);
  let seen; const good = make(p => { seen = p; return { bsize: 4096n, bavail: BigInt(70 * G / 4096) }; });
  assert.equal(good.sample(link).state, "NORMAL"); assert.equal(seen, fs.realpathSync(root));
  assert.equal(good.sample(path.join(root,"missing")).state, "UNAVAILABLE");
  assert.equal(good.sample(path.join(root,"missing"), true).state, "NORMAL");
  for (const value of [{bsize:0,bavail:1}, {bsize:NaN,bavail:1}, {bsize:1,bavail:-1}, {bsize:1n,bavail:2n**80n}, null]) assert.equal(make(() => value).sample(root).state, "UNAVAILABLE");
  assert.equal(make(() => { throw Error("secret"); }).sample(root).state, "UNAVAILABLE");
  let now = 0; const stale = make(() => ({bsize:1,bavail:70*G}), { clock: () => (now += 5000), maxAgeMs: 1000 });
  assert.equal(stale.decision(root, root).state, "UNAVAILABLE");
  assert.throws(() => make(() => ({}), { thresholds: { normal: 3, warning: 3, critical: 1 } }));
});

test("denial occurs before registry creation and process spawn", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let spawned = false; const dir = path.join(root, "registry");
  const m = new JobManager(dir, { spawn: () => { spawned = true; }, storageOptions: { statfs: () => ({ bsize: 1, bavail: 20 * G }) } });
  t.after(() => m.shutdown());
  const result = await m.start({ executable: process.execPath, cwd: root });
  assert.equal(result.error.code, "STORAGE_ADMISSION_DENIED"); assert.equal(result.error.reason, "EMERGENCY");
  assert.equal(spawned, false); assert.equal(fs.existsSync(dir), false);
});

test("periodic snapshots transition, become stale, and stop without touching jobs", async () => {
  let gb = 70, now = 10000, cancelled = false;
  const monitor = make(() => ({bsize:1,bavail:gb*G}), { intervalMs: 1000, maxAgeMs: 1000, clock: () => now });
  monitor.start(os.tmpdir(), () => [["job", os.tmpdir()]]);
  assert.equal(monitor.timer.hasRef(), false);
  await new Promise(r => setTimeout(r, 1050)); assert.equal(monitor.snapshot("job").state, "NORMAL");
  gb = 20; now += 100; await new Promise(r => setTimeout(r, 1050)); assert.equal(monitor.snapshot("job").state, "EMERGENCY");
  assert.equal(cancelled, false); now += 1001; assert.equal(monitor.snapshot("job").state, "UNAVAILABLE");
  monitor.stop(); assert.equal(monitor.timer, null); assert.equal(monitor.snapshot("job"), null);
});

test("monitoring an active job does not stop it under pressure", async t => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "storage-active-"));
  let gb = 70, stops = 0, child;
  const m = new JobManager(path.join(root, "registry"), { storageOptions: { intervalMs: 1000, statfs: () => ({ bsize: 1, bavail: gb * G }) }, spawn: () => {
    child = new EventEmitter();
    Object.assign(child, { connected: true, stdout: new PassThrough(), stderr: new PassThrough(), send(message, callback) { if (message.type === "stop") stops++; callback?.(null); } });
    return child;
  } });
  t.after(() => { m.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const job = await m.start({ executable: process.execPath, cwd: root });
  child.emit("spawn"); child.emit("message", {type:"spawned"});
  const recordPath = path.join(root, "registry", `${job.job_id}.json`);
  const before = fs.readFileSync(recordPath, "utf8");
  gb = 20; await new Promise(r => setTimeout(r, 1050));
  assert.equal(m.status({job_id:job.job_id}).storage_monitor.state, "EMERGENCY");
  assert.equal(m.status({job_id:job.job_id}).status, "running"); assert.equal(stops, 0);
  assert.equal(fs.readFileSync(recordPath, "utf8"), before);
  await assert.rejects(m.start({ executable: process.execPath, cwd: root, storage_class: "safe" }));
  child.emit("message", {type:"result", reason:null, code:0, signal:null});
  child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
  assert.equal(m.status({job_id:job.job_id}).status, "success");
});
