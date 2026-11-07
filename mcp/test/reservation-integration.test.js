import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StorageSafety } from "../storage-safety.js";
import { StorageReservations } from "../storage-reservations.js";
import { terminalExec } from "../exec.js";
import { JobManager } from "../jobs.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
function supervisor() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
  child.send = (_message, callback) => callback?.(); child.disconnect = () => { child.connected = false; };
  child.finish = (crash = false) => {
    if (!crash) child.emit("message", { type: "result", code: 0, signal: null, reason: null });
    child.emit("exit", crash ? 1 : null, crash ? null : "SIGKILL");
    child.emit("close", crash ? 1 : null, crash ? null : "SIGKILL");
  };
  setImmediate(() => child.emit("spawn"));
  return child;
}

test("exec and starting job share a reservation until supervisor close, including crash and launch failure", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservation-integration-"));
  const storage = new StorageSafety({ thresholds: { normal: 100, warning: 80, critical: 50 }, statfs: () => ({ bsize: 1, bavail: 130 }) });
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const children = []; const spawn = () => { const child = supervisor(); children.push(child); return child; };
  const manager = new JobManager(dir, { storage, reservations, spawn });
  t.after(() => { manager.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const input = { executable: "x", cwd: dir, timeout_ms: 10000 };
  const job = await manager.start(input);
  assert.equal(job.status, "starting");
  const execution = terminalExec(input, { storage, reservations, registry: dir, spawn });
  while (children.length < 2) await tick();
  const denied = await manager.start(input);
  assert.equal(denied.error.code, "STORAGE_ADMISSION_DENIED"); assert.equal(denied.error.reason, "RESERVATION_EXHAUSTED");
  children[0].finish();
  const replacement = await manager.start(input); assert.equal(replacement.status, "starting");
  children[1].finish(true); assert.equal((await execution).error.code, "TERMINATION_UNAVAILABLE");
  const failing = await terminalExec(input, { storage, reservations, registry: dir, spawn: () => { throw Error("failure"); } });
  assert.equal(failing.error.code, "SUPERVISOR_UNAVAILABLE");
  assert.equal(reservations.reserved.size, 1);
  children[2].finish(true);
  assert.equal(reservations.reserved.size, 0);
  const failedJob = new JobManager(path.join(dir, "other"), { storage, reservations, spawn: () => { throw Error("failure"); } });
  assert.equal((await failedJob.start(input)).error.code, "SUPERVISOR_UNAVAILABLE");
  assert.equal(reservations.reserved.size, 0);
  assert.equal(fs.existsSync(path.join(dir, "other", ".lock")), false); failedJob.shutdown();
});

test("unknown free space denies both entry points without spawning or creating a registry", async t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reservation-unknown-")), "registry");
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const storage = new StorageSafety({ thresholds: { normal: 100, warning: 80, critical: 50 }, statfs: () => { throw Error("unavailable"); } });
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const manager = new JobManager(dir, { storage, reservations, spawn: () => { throw Error("must not spawn"); } });
  const input = { executable: "x", cwd: os.tmpdir() };
  for (const result of [await manager.start(input), await terminalExec(input, { storage, reservations, registry: dir })]) {
    assert.equal(result.error.code, "STORAGE_ADMISSION_DENIED"); assert.equal(result.error.reason, "UNAVAILABLE");
  }
  assert.equal(fs.existsSync(dir), false); assert.equal(reservations.reserved.size, 0); manager.shutdown();
});

test("timeout, output overflow, cancellation and shutdown release only after close", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reservation-lifecycle-"));
  const storage = new StorageSafety({ thresholds: { normal: 100, warning: 80, critical: 50 }, statfs: () => ({ bsize: 1, bavail: 130 }) });
  const reservations = new StorageReservations({ budget: 10, minimumReserve: 10 });
  const manager = new JobManager(dir, { storage, reservations });
  t.after(() => { manager.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const exec = (code, extra = {}) => terminalExec({ executable: process.execPath, args: ["-e", code], cwd: dir, ...extra }, { storage, reservations, registry: dir });
  assert.equal((await exec("setInterval(()=>{},1000)", { timeout_ms: 100 })).status, "timeout");
  assert.equal(reservations.reserved.size, 0);
  assert.equal((await exec("process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)", { max_output_bytes: 10 })).status, "output_limit");
  assert.equal(reservations.reserved.size, 0);
  for (const action of ["cancel", "shutdown"]) {
    const job = await manager.start({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: dir });
    assert.equal(reservations.reserved.size, 1);
    if (action === "cancel") manager.cancel({ job_id: job.job_id }); else manager.shutdown();
    assert.equal(reservations.reserved.size, 1);
    for (let i = 0; i < 300 && reservations.reserved.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reservations.reserved.size, 0);
  }
});
