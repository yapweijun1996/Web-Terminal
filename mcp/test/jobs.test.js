import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { JobManager as RealJobManager } from "../jobs.js";
const fakeStatfs = () => ({ bsize: 1n, bavail: 100n * 1024n ** 3n });
class JobManager extends RealJobManager { constructor(dir, options = {}) { super(dir, { ...options, storageOptions: { statfs: fakeStatfs } }); } }

const wait = ms => new Promise(r => setTimeout(r, ms));
async function done(m, job_id) { for (let i = 0; i < 300; i++) { const s = m.status({ job_id }); if (!["starting", "running"].includes(s.status)) return s; await wait(10); } throw Error("job did not finish"); }
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-test-")); const m = new JobManager(dir); t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }); return { m, dir }; }
const start = (m, code, extra = {}) => m.start({ executable: process.execPath, args: ["-e", code], cwd: os.tmpdir(), ...extra });
const read = (m, job_id, stream = "stdout", offset = 0, limit = 65536) => m.logs({ job_id, stream, offset, limit });

test("success, stderr, nonzero exit and byte pagination", async t => {
  const { m, dir } = fixture(t);
  const j = await start(m, "process.stdout.write('abcdef'); process.stderr.write('problem'); process.exitCode=7");
  const s = await done(m, j.job_id); assert.equal(s.status, "failed"); assert.equal(s.exit_code, 7);
  const a = read(m, j.job_id, "stdout", 0, 3), b = read(m, j.job_id, "stdout", a.next_offset, 3);
  assert.equal(Buffer.from(a.data_base64 + b.data_base64, "base64").toString(), "abcdef");
  assert.equal(Buffer.from(read(m, j.job_id, "stderr").data_base64, "base64").toString(), "problem");
  assert.equal(fs.statSync(path.join(dir, j.job_id + ".json")).mode & 0o777, 0o600);
  const literal = "$(echo untouched); $HOME";
  const ok = await m.start({ executable: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", literal], cwd: dir });
  assert.equal((await done(m, ok.job_id)).status, "success");
  assert.equal(Buffer.from(read(m, ok.job_id).data_base64, "base64").toString(), literal);
  const missing = await m.start({ executable: "/missing-job-executable", cwd: dir });
  assert.equal((await done(m, missing.job_id)).error.code, "SPAWN_FAILED");
});
test("output bound, timeout, cancellation and concurrency", async t => {
  const { m } = fixture(t);
  const out = await start(m, "process.stdout.write('x'.repeat(2000))", { max_output_bytes: 100 });
  assert.equal((await done(m, out.job_id)).stdout_truncated, true); assert.equal(read(m, out.job_id).total_bytes, 100);
  const timeout = await start(m, "setTimeout(()=>{},700)", { timeout_ms: 100 }); assert.equal((await done(m, timeout.job_id)).status, "timeout");
  const jobs = await Promise.all(Array.from({ length: 4 }, () => start(m, "setTimeout(()=>{},700)")));
  assert.equal((await start(m, "")).error.code, "CONCURRENCY_LIMIT");
  for (const job of jobs) m.cancel({ job_id: job.job_id });
  for (const job of jobs) assert.equal((await done(m, job.job_id)).status, "cancelled");
});
test("exclusive writer and restart after shutdown", async t => {
  const { m, dir } = fixture(t);
  const j = await start(m, "setTimeout(()=>{},700)");
  const other = new JobManager(dir); assert.throws(() => other.init(), /live process/);
  assert.throws(() => other.status({ job_id: "../outside" }));
  m.cancel({ job_id: j.job_id }); await done(m, j.job_id); m.shutdown();
  assert.equal(other.status({ job_id: j.job_id }).status, "cancelled"); other.shutdown();
});

test("malformed, live and demonstrated dead locks fail closed or recover", t => {
  const { dir } = fixture(t), lock = path.join(dir, ".lock");
  fs.mkdirSync(lock, { mode: 0o700 }); const owner = path.join(lock, "owner.json");
  fs.writeFileSync(owner, "{", { mode: 0o600 });
  assert.throws(() => new JobManager(dir).init());
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  assert.throws(() => new JobManager(dir).init(), /live process/);
  fs.writeFileSync(owner, JSON.stringify({ pid: 2147483647, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  const recovered = new JobManager(dir); recovered.init();
  assert.equal(fs.statSync(lock).mode & 0o777, 0o700); recovered.shutdown();
  assert.equal(fs.existsSync(lock), false);
});

test("orphan records survive retention and quota pressure", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-orphan-"));
  const id = "12345678-1234-4123-8123-123456789abc";
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ job_id: id, status: "running", stdout: "", stderr: "" }), { mode: 0o600 });
  const m = new JobManager(dir, { maxJobs: 1, maxBytes: 100000, retentionMs: 1 });
  t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(m.status({ job_id: id }).error.code, "SERVER_RESTART");
  await wait(5);
  assert.equal((await start(m, "", { max_output_bytes: 100 })).error.code, "STORAGE_QUOTA");
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true);
});

test("shutdown does not release a replaced lock", t => {
  const { m, dir } = fixture(t); m.init();
  const owner = path.join(dir, ".lock", "owner.json");
  fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  m.shutdown(); assert.equal(fs.existsSync(owner), true);
});

test("quota and retention evict only eligible terminal jobs", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-quota-"));
  const m = new JobManager(dir, { maxJobs: 1, maxBytes: 100000, retentionMs: 1 });
  t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const first = await start(m, "setTimeout(()=>{},700)", { max_output_bytes: 100 });
  assert.equal((await start(m, "", { max_output_bytes: 100 })).error.code, "STORAGE_QUOTA");
  m.cancel({ job_id: first.job_id }); await done(m, first.job_id); await wait(5);
  const second = await start(m, "", { max_output_bytes: 100 });
  assert.equal((await done(m, second.job_id)).status, "success"); assert.equal(fs.existsSync(path.join(dir, first.job_id + ".json")), false);
  m.shutdown();
  const tiny = new JobManager(dir, { maxBytes: 100, maxJobs: 2, retentionMs: 10000 });
  await assert.rejects(start(tiny, "", { max_output_bytes: 100 }), /quota/); tiny.shutdown();
});

test("live lock competition across processes and crash recovery preserves unknown outcome", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-process-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = new URL("../jobs.js", import.meta.url).href;
  const id = "12345678-1234-4123-8123-123456789abc";
  const script = `import { JobManager } from ${JSON.stringify(moduleUrl)}; const m = new JobManager(process.argv[1]); m.init(); m.save({job_id: process.argv[2], status: 'running', stdout: '', stderr: '', pid: process.pid}); console.log('ready'); setInterval(()=>{}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, id], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const [data] = await once(child.stdout, "data"); assert.match(data.toString(), /ready/);
  const contender = spawnSync(process.execPath, ["--input-type=module", "-e", `import { JobManager } from ${JSON.stringify(moduleUrl)}; try { new JobManager(process.argv[1]).init(); process.exit(2); } catch (e) { if (!/live process/.test(e.message)) process.exit(3); }`, dir]);
  assert.equal(contender.status, 0, contender.stderr.toString());
  child.kill("SIGKILL"); await once(child, "exit");
  const m = new JobManager(dir, { maxJobs: 1, maxBytes: 100000, retentionMs: 1 });
  t.after(() => m.shutdown());
  const orphan = m.status({ job_id: id });
  assert.equal(orphan.status, "interrupted"); assert.equal(orphan.finished_at, null);
  assert.match(orphan.error.message, /unknown/);
  assert.equal((await start(m, "", { max_output_bytes: 100 })).error.code, "STORAGE_QUOTA");
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true);
});

test("atomic replacement counts lock and both record copies at byte boundary", t => {
  const { m, dir } = fixture(t); m.init();
  const id = "12345678-1234-4123-8123-123456789abc";
  const record = { job_id: id, status: "success", stdout: "", stderr: "" };
  m.save(record);
  const ownerSize = fs.statSync(path.join(dir, ".lock", "owner.json")).size;
  const recordSize = Buffer.byteLength(JSON.stringify(record));
  m.maxBytes = ownerSize + recordSize * 2 - 1;
  assert.throws(() => m.save(record), /quota/);
  assert.equal(fs.statSync(path.join(dir, `${id}.json`)).size, recordSize);
  m.maxBytes++; m.save(record);
  fs.writeFileSync(path.join(dir, ".unknown.tmp"), "x", { mode: 0o600 });
  assert.throws(() => m.save(record), /Unsafe registry entry/);
});

test("reservation boundary holds throughout log and final atomic writes", async t => {
  const { m, dir } = fixture(t); m.init();
  const ownerSize = fs.statSync(path.join(dir, ".lock", "owner.json")).size;
  const reserve = 2 * (Math.ceil(100 / 3) * 4 + 8192);
  m.maxBytes = ownerSize + reserve - 1;
  assert.equal((await start(m, "", { max_output_bytes: 100 })).error.code, "STORAGE_QUOTA");
  m.maxBytes++;
  let peak = 0; const original = fs.writeFileSync;
  try {
    fs.writeFileSync = (...args) => {
      const result = original(...args);
      const bytes = fs.readdirSync(dir).reduce((total, name) => name === ".lock" ? total + fs.statSync(path.join(dir, name, "owner.json")).size : total + fs.statSync(path.join(dir, name)).size, 0);
      peak = Math.max(peak, bytes); return result;
    };
    const job = await start(m, "process.stdout.write('x'.repeat(100))", { max_output_bytes: 100 });
    assert.equal((await done(m, job.job_id)).status, "success");
  } finally { fs.writeFileSync = original; }
  assert.ok(peak > ownerSize); assert.ok(peak <= m.maxBytes);
});

test("rejects unsafe directory and symlinked record", async t => {
  const { m, dir } = fixture(t);
  const outside = path.join(dir, "outside"); fs.writeFileSync(outside, "untouched");
  const id = "12345678-1234-4123-8123-123456789abc";
  fs.symlinkSync(outside, path.join(dir, `${id}.json`));
  assert.throws(() => m.status({ job_id: id }));
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
  const unsafe = path.join(dir, "unsafe"); fs.mkdirSync(unsafe, { mode: 0o755 }); fs.chmodSync(unsafe, 0o755);
  assert.throws(() => new JobManager(unsafe).init());
});

test("failed record flush preserves the previous record and removes its temporary file", t => {
  const { m, dir } = fixture(t);
  const id = "12345678-1234-4123-8123-123456789abc";
  const record = { job_id: id, status: "success", stdout: "", stderr: "" };
  m.init();
  m.save(record);
  const previous = fs.readFileSync(path.join(dir, `${id}.json`), "utf8");
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => { throw Error("injected flush failure"); };
    assert.throws(() => m.save({ ...record, status: "failed" }), /injected/);
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.readFileSync(path.join(dir, `${id}.json`), "utf8"), previous);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".lock", `${id}.json`].sort());
});

test("fail closed on hard quota requirement and ENOSPC preserves old record", t => {
  const { m, dir } = fixture(t);
  const prior = process.env.WEB_TERMINAL_REQUIRE_HARD_QUOTA;
  process.env.WEB_TERMINAL_REQUIRE_HARD_QUOTA = "1";
  try { assert.throws(() => m.init(), /Hard quota verification unavailable/); }
  finally { if (prior === undefined) delete process.env.WEB_TERMINAL_REQUIRE_HARD_QUOTA; else process.env.WEB_TERMINAL_REQUIRE_HARD_QUOTA = prior; }
  m.init();
  const id = "12345678-1234-4123-8123-123456789abc", record = { job_id: id, status: "success", stdout: "", stderr: "" };
  m.save(record); const file = path.join(dir, `${id}.json`), before = fs.readFileSync(file, "utf8");
  const write = fs.writeFileSync;
  try { fs.writeFileSync = () => { const e = Error("disk full"); e.code = "ENOSPC"; throw e; }; assert.throws(() => m.save({ ...record, status: "failed" }), /disk full/); }
  finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), [".lock", `${id}.json`].sort());
});

test("recovered fake completed records are never evicted", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-fake-"));
  const id = "12345678-1234-4123-8123-123456789abc";
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ job_id: id, status: "success", finished_at: "2000-01-01", stdout: "", stderr: "", pid: process.pid }), { mode: 0o600 });
  const m = new JobManager(dir, { maxJobs: 1, maxBytes: 100000, retentionMs: 1 });
  t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await start(m, "", { max_output_bytes: 100 })).error.code, "STORAGE_QUOTA");
  assert.ok(fs.existsSync(path.join(dir, `${id}.json`)));
});


test("controller SIGKILL disconnect stops a test-owned heartbeat", { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-crash-"));
  const registry = path.join(dir, "registry"), heartbeat = path.join(dir, "heartbeat");
  const moduleUrl = new URL("../jobs.js", import.meta.url).href;
  const jobCode = `const fs=require('fs'); const p=process.argv[1]; fs.appendFileSync(p,'x'); setInterval(()=>fs.appendFileSync(p,'x'),30)`;
  const script = `import { JobManager } from ${JSON.stringify(moduleUrl)}; const m=new JobManager(process.argv[1], {storageOptions:{statfs:()=>({bsize:1n,bavail:100n*1024n**3n})}}); await m.start({executable:process.execPath,args:['-e',${JSON.stringify(jobCode)},process.argv[2]],cwd:process.cwd(),timeout_ms:10000}); console.log('ready'); setInterval(()=>{},1000)`;
  const controller = spawn(process.execPath, ["--input-type=module", "-e", script, registry, heartbeat], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (controller.exitCode === null && controller.signalCode === null) controller.kill("SIGKILL"); fs.rmSync(dir, { recursive: true, force: true }); });
  await once(controller.stdout, "data");
  for (let i=0; i<100 && (!fs.existsSync(heartbeat) || fs.statSync(heartbeat).size < 3); i++) await wait(30);
  assert.ok(fs.existsSync(heartbeat) && fs.statSync(heartbeat).size >= 3);
  controller.kill("SIGKILL"); await once(controller, "exit");
  await wait(900); const size = fs.statSync(heartbeat).size; await wait(300);
  assert.equal(fs.statSync(heartbeat).size, size);
  const m = new JobManager(registry); t.after(() => m.shutdown()); m.init();
  const id = fs.readdirSync(registry).find(n => n.endsWith(".json")).slice(0, -5);
  assert.equal(m.status({ job_id: id }).status, "interrupted");
});

test("cancel after observed child exit cannot overwrite normal result", async t => {
  const { m } = fixture(t);
  const job = await start(m, "process.stdout.write('done')");
  const result = await done(m, job.job_id);
  assert.equal(result.status, "success");
  assert.equal(m.cancel({ job_id: job.job_id }).status, "success");
});

test("missing supervisor confirmation fails closed without signalling a reused PID", async t => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-fault-"));
  let fake, stops = 0; const m = new JobManager(dir, { spawn: () => {
    fake = new EventEmitter(); Object.assign(fake, { pid: process.pid, connected: true, stdout: new PassThrough(), stderr: new PassThrough(), send(message, callback) { if (message.type === "stop") stops++; callback?.(null); }, disconnect() { this.connected = false; } }); return fake;
  } });
  t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const job = await start(m, "");
  assert.equal(job.status, "starting"); assert.equal(job.started_at, null);
  fake.emit("spawn"); assert.equal(m.status({ job_id: job.job_id }).status, "starting");
  fake.emit("message", { type: "spawned" });
  assert.equal(m.status({ job_id: job.job_id }).status, "running");
  const kill = process.kill; let calls = 0;
  try { process.kill = () => { calls++; throw Error("unsafe PID signal"); }; m.cancel({ job_id: job.job_id }); m.cancel({ job_id: job.job_id }); fake.emit("exit", null, "SIGKILL"); m.cancel({ job_id: job.job_id }); fake.emit("close", null, "SIGKILL"); }
  finally { process.kill = kill; }
  assert.equal(calls, 0); assert.equal(stops, 1); assert.equal(m.status({ job_id: job.job_id }).error.code, "TERMINATION_UNAVAILABLE");
});

test("supervisor stop before start never spawns the requested executable", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "supervisor-stop-first-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "marker");
  const child = spawn(process.execPath, [new URL("../job-supervisor.js", import.meta.url).pathname], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const messages = []; child.on("message", message => messages.push(message));
  const closed = once(child, "close");
  child.send({ type: "stop", reason: "cancelled" });
  child.send({ type: "start", executable: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'bad')", marker], cwd: dir });
  await closed;
  assert.ok(messages.some(message => message.type === "result" && message.reason === "cancelled"));
  assert.equal(fs.existsSync(marker), false);
});

test("cancel racing with an already observed job exit retains the exit result", async t => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobs-race-")); let fake;
  const m = new JobManager(dir, { spawn: () => {
    fake = new EventEmitter(); Object.assign(fake, { connected: true, stdout: new PassThrough(), stderr: new PassThrough(), send(_message, callback) { callback?.(null); } }); return fake;
  } });
  t.after(() => { m.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const job = await start(m, ""); fake.emit("spawn"); fake.emit("message", { type: "spawned" });
  m.cancel({ job_id: job.job_id });
  fake.emit("message", { type: "result", reason: null, code: 0, signal: null });
  fake.emit("exit", null, "SIGKILL"); fake.emit("close", null, "SIGKILL");
  assert.equal(m.status({ job_id: job.job_id }).status, "success");
});

test("timeout kills a signal-resistant test-owned descendant", { timeout: 10000 }, async t => {
  const { m, dir } = fixture(t);
  // Keep the fixture outside the registry, whose entries are strictly validated.
  const outside = path.join(os.tmpdir(), `heartbeat-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(outside, { force: true }));
  const code = `const fs=require('fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)`;
  const launcher = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(code)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000)`;
  const job = await m.start({ executable: process.execPath, args: ["-e", launcher, outside], cwd: dir, timeout_ms: 500 });
  assert.equal((await done(m, job.job_id)).status, "timeout");
  assert.ok(fs.existsSync(outside)); const size = fs.statSync(outside).size; await wait(250); assert.equal(fs.statSync(outside).size, size);
});
