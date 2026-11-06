import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StorageSafety } from "./storage-safety.js";
import { storageReservations } from "./storage-reservations.js";
import { restartRetentionPolicy, previewLegacyMigration } from "./restart-retention.js";

const literal = z.string().refine(s => !s.includes("\0"));
export const jobStartInput = {
  executable: literal.min(1).max(4096), args: z.array(literal.max(8192)).max(128).default([]),
  cwd: literal.min(1).max(4096).refine(path.isAbsolute),
  storage_class: z.enum(["unknown", "light", "heavy"]).default("unknown"),
  timeout_ms: z.number().int().min(100).max(3600000).default(60000),
  max_output_bytes: z.number().int().min(1).max(1048576).default(262144),
};
export const jobId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const jobLogsInput = { job_id: jobId, stream: z.enum(["stdout", "stderr"]).default("stdout"), offset: z.number().int().min(0).max(1048576).default(0), limit: z.number().int().min(1).max(65536).default(16384) };
const startSchema = z.object(jobStartInput).strict();
const logsSchema = z.object(jobLogsInput).strict();
const terminal = new Set(["success", "failed", "error", "timeout", "cancelled", "interrupted"]);
const digest = record => createHash("sha256").update(JSON.stringify(record)).digest("hex");

export class JobManager {
  constructor(dir = process.env.WEB_TERMINAL_JOB_DIR || path.join(os.homedir(), ".web-terminal-jobs"), options = {}) {
    if (!path.isAbsolute(dir)) throw Error("Job directory must be absolute");
    this.dir = dir; this.active = new Map(); this.finishedHere = new Map(); this.initialized = false; this.closed = false;
    this.spawn = options.spawn ?? spawn;
    this.storage = options.storage ?? new StorageSafety(options.storageOptions);
    this.reservations = options.reservations ?? storageReservations;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxJobs = options.maxJobs ?? 1000;
    this.retentionMs = options.retentionMs ?? 30 * 86400000;
    this.restartRetention = restartRetentionPolicy({ optIn: options.restartRetentionOptIn ?? false });
    if (![this.maxBytes, this.maxJobs, this.retentionMs].every(n => Number.isSafeInteger(n) && n > 0)) throw Error("Invalid retention configuration");
  }
  previewMigration(options) { return previewLegacyMigration(this.dir, options); }
  acquireLock() {
    const lock = path.join(this.dir, ".lock"), gate = path.join(this.dir, ".recovery");
    const exists = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
    if (exists(gate)) throw Error("Registry recovery in progress or ambiguous");
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { fs.mkdirSync(gate, { mode: 0o700 }); } catch { throw Error("Registry recovery in progress or ambiguous"); }
      try {
        const before = fs.lstatSync(lock);
        if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o700) throw Error("Invalid registry lock");
        const owner = path.join(lock, "owner.json"), st = fs.lstatSync(owner);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > 1024) throw Error("Invalid registry lock owner");
        const fd = fs.openSync(owner, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let data;
        try { const opened = fs.fstatSync(fd); if (opened.ino !== st.ino || opened.dev !== st.dev) throw Error("Registry owner changed"); data = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
        if (!Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.token !== "string" || !/^[0-9a-f-]{36}$/.test(data.token)) throw Error("Invalid registry lock owner");
        try { process.kill(data.pid, 0); throw Error("Registry is locked by a live process"); } catch (err) { if (err.code !== "ESRCH") throw err; }
        const after = fs.lstatSync(lock), ownerAfter = fs.lstatSync(owner);
        if (before.ino !== after.ino || before.dev !== after.dev || st.ino !== ownerAfter.ino || st.dev !== ownerAfter.dev || fs.readdirSync(lock).length !== 1) throw Error("Registry lock changed");
        fs.unlinkSync(owner); fs.rmdirSync(lock);
        fs.mkdirSync(lock, { mode: 0o700 });
        this.writeLock(lock);
      } finally { fs.rmdirSync(gate); }
      return;
    }
    if (exists(gate)) { fs.rmdirSync(lock); throw Error("Registry recovery in progress"); }
    this.writeLock(lock);
  }
  writeLock(lock) {
    const token = randomUUID();
    try {
      const owner = JSON.stringify({ pid: process.pid, token });
      if (this.registryBytes(true) + Buffer.byteLength(owner) > this.maxBytes) throw Error("Registry storage quota exceeded");
      fs.writeFileSync(path.join(lock, "owner.json"), owner, { flag: "wx", mode: 0o600 });
      const st = fs.lstatSync(lock); this.lock = { path: lock, dev: st.dev, ino: st.ino, token };
    } catch (e) { try { fs.unlinkSync(path.join(lock, "owner.json")); } catch {} try { fs.rmdirSync(lock); } catch {} throw e; }
  }
  releaseLock() {
    if (!this.lock) return;
    const lock = this.lock; this.lock = null;
    try {
      const st = fs.lstatSync(lock.path), owner = path.join(lock.path, "owner.json"), ost = fs.lstatSync(owner);
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== lock.dev || st.ino !== lock.ino || !ost.isFile() || ost.isSymbolicLink()) return;
      const fd = fs.openSync(owner, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let data; try { const opened = fs.fstatSync(fd); if (opened.ino !== ost.ino || opened.dev !== ost.dev) return; data = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
      if (data.pid !== process.pid || data.token !== lock.token || fs.readdirSync(lock.path).length !== 1) return;
      fs.unlinkSync(owner); fs.rmdirSync(lock.path);
    } catch { /* ambiguous ownership must remain locked */ }
  }
  init() {
    if (this.closed) throw Error("Job manager is shut down");
    if (this.initialized) return;
    if (process.env.WEB_TERMINAL_REQUIRE_HARD_QUOTA === "1") throw Error("Hard quota verification unavailable; refusing startup");
    fs.mkdirSync(this.dir, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(this.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error("Job directory must be private and owned");
    this.acquireLock();
    try {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json") || !jobId.safeParse(name.slice(0, -5)).success) continue;
      const id = name.slice(0, -5);
      const record = this.read(id);
      if (record && !terminal.has(record.status)) {
        record.status = "interrupted"; record.finished_at = null;
        record.error = { code: "SERVER_RESTART", message: "Job outcome is unknown after server restart" };
        this.save(record);
      }
    }
    this.initialized = true;
    } catch (e) { this.releaseLock(); throw e; }
  }
  file(id) { if (!jobId.safeParse(id).success) throw Error("Invalid job ID"); return path.join(this.dir, `${id}.json`); }
  read(id) {
    const file = this.file(id);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 3000000) throw Error("Invalid job file");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let data;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.dev !== st.dev || opened.ino !== st.ino || !opened.isFile()) throw Error("Job file changed");
        data = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally { fs.closeSync(fd); }
      if (data.job_id !== id || typeof data.stdout !== "string" || typeof data.stderr !== "string") throw Error("Invalid job record");
      return data;
    } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  save(record) {
    if (!this.lock) throw Error("Registry lock is not owned");
    const lockStat = fs.lstatSync(this.lock.path);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.dev !== this.lock.dev || lockStat.ino !== this.lock.ino) throw Error("Registry lock changed");
    const ownerPath = path.join(this.lock.path, "owner.json"), ownerStat = fs.lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) throw Error("Registry lock owner changed");
    const ownerFd = fs.openSync(ownerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(ownerFd), owner = JSON.parse(fs.readFileSync(ownerFd, "utf8"));
      if (opened.ino !== ownerStat.ino || opened.dev !== ownerStat.dev || owner.pid !== process.pid || owner.token !== this.lock.token) throw Error("Registry lock owner changed");
    } finally { fs.closeSync(ownerFd); }
    const target = this.file(record.job_id);
    try { const st = fs.lstatSync(target); if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error("Invalid job file"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const temp = path.join(this.dir, `.${randomUUID()}.tmp`);
    const payload = JSON.stringify(record);
    if (this.registryBytes() + Buffer.byteLength(payload) > this.maxBytes) throw Error("Registry storage quota exceeded");
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, target);
      const dirFd = fs.openSync(this.dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    finally { try { fs.unlinkSync(temp); } catch (e) { if (e.code !== "ENOENT") throw e; } }
  }
  registryBytes(emptyLock = false) {
    let used = 0;
    for (const name of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, name), st = fs.lstatSync(file);
      if (name === ".recovery" && emptyLock && st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700 && fs.readdirSync(file).length === 0) continue;
      if (name === ".lock") {
        if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw Error("Unsafe registry lock");
        const entries = fs.readdirSync(file);
        if (emptyLock && entries.length === 0) continue;
        if (entries.length !== 1 || entries[0] !== "owner.json") throw Error("Unsafe registry lock entry");
        const owner = fs.lstatSync(path.join(file, "owner.json"));
        if (!owner.isFile() || owner.isSymbolicLink() || owner.uid !== process.getuid() || (owner.mode & 0o777) !== 0o600) throw Error("Unsafe registry lock owner");
        used += owner.size;
      } else {
        if (!name.endsWith(".json") || !jobId.safeParse(name.slice(0, -5)).success || !st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077)) throw Error("Unsafe registry entry");
        used += st.size;
      }
    }
    return used;
  }
  capacity(reserve) {
    let used = this.registryBytes(), count = 0; const candidates = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (name === ".lock") continue;
      const file = path.join(this.dir, name), st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile() || st.uid !== process.getuid()) throw Error("Unsafe registry entry");
      if (!name.endsWith(".json") || !jobId.safeParse(name.slice(0, -5)).success) throw Error("Unsafe registry entry");
      count++; const id = name.slice(0, -5), record = this.read(id);
      if (record && this.finishedHere.get(id) === digest(record) && !this.active.has(id) && terminal.has(record.status) && record.status !== "interrupted" && record.error?.code !== "SERVER_RESTART" && Number.isFinite(Date.parse(record.finished_at))) candidates.push({ file, st, time: Date.parse(record.finished_at) });
    }
    const reserved = [...this.active.values()].reduce((n, job) => n + job.reserve, 0);
    candidates.sort((a, b) => a.time - b.time);
    for (const candidate of candidates) {
      if (Date.now() - candidate.time < this.retentionMs && count < this.maxJobs && used + reserved + reserve <= this.maxBytes) continue;
      const now = fs.lstatSync(candidate.file);
      if (!now.isFile() || now.isSymbolicLink() || now.ino !== candidate.st.ino || now.dev !== candidate.st.dev) throw Error("Registry entry changed");
      fs.unlinkSync(candidate.file); this.finishedHere.delete(path.basename(candidate.file, ".json")); used -= candidate.st.size; count--;
    }
    return count < this.maxJobs && used + reserved + reserve <= this.maxBytes;
  }
  public(record) { const { stdout, stderr, ...info } = record; return info; }
  status({ job_id }) { this.init(); const r = this.active.get(job_id)?.record || this.read(job_id); if (!r) throw Error("Job not found"); const info = this.public(r); const storage = this.storage.snapshot(job_id); return storage ? { ...info, storage_monitor: storage } : info; }
  logs(input) {
    const { job_id, stream, offset, limit } = logsSchema.parse(input); this.init();
    const r = this.active.get(job_id)?.record || this.read(job_id); if (!r) throw Error("Job not found");
    const data = Buffer.from(r[stream], "base64"); const end = Math.min(data.length, offset + limit);
    return { job_id, stream, offset, next_offset: Math.max(offset, end), total_bytes: data.length, data_base64: data.subarray(offset, end).toString("base64"), truncated: r[`${stream}_truncated`] };
  }
  cancel({ job_id }) { this.init(); const active = this.active.get(job_id); if (!active) return this.status({ job_id }); active.stop("cancelled"); return this.public(active.record); }
  shutdown() { this.storage.stop(); this.closed = true; for (const job of this.active.values()) job.stop("interrupted"); if (!this.active.size) this.releaseLock(); }
  async start(input) {
    const { executable, args, cwd, timeout_ms, max_output_bytes } = startSchema.parse(input);
    const admission = this.reservations.acquire(this.storage, this.dir, cwd);
    let decision = admission.decision;
    if (!decision.allowed) return { error: { code: "STORAGE_ADMISSION_DENIED", reason: decision.state, message: "Storage admission denied", ...decision } };
    let handedOff = false;
    try {
    this.init();
    // Creating a previously absent registry changes its identity; resample without
    // allocating a second reservation and reject any device change.
    const current = this.storage.decision(this.dir, cwd);
    if (!current.allowed || !this.storage.verify(current) || ["registry", "cwd"].some(name => current.identities?.[name]?.dev !== decision.identities?.[name]?.dev)) {
      return { error: { code: "STORAGE_ADMISSION_DENIED", reason: current.allowed ? "UNAVAILABLE" : current.state, message: "Storage admission denied", ...current, allowed: false, state: current.allowed ? "UNAVAILABLE" : current.state } };
    }
    decision = current;
    if (this.active.size >= 4) return { error: { code: "CONCURRENCY_LIMIT", message: "Job capacity reached" } };
    // Reserve both the final record and the temporary atomic replacement at maximum output size.
    const reserve = 2 * (Math.ceil(max_output_bytes / 3) * 4 + 8192);
    if (!this.capacity(reserve)) return { error: { code: "STORAGE_QUOTA", message: "Job storage capacity reached" } };
    const record = { job_id: randomUUID(), status: "starting", started_at: null, finished_at: null, exit_code: null, signal: null, error: null, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false };
    this.save(record);
    if (!this.storage.verify(decision)) {
      record.status = "error"; record.finished_at = new Date().toISOString();
      record.error = { code: "STORAGE_ADMISSION_DENIED", reason: "UNAVAILABLE", message: "Storage admission denied", ...decision, allowed: false, state: "UNAVAILABLE" };
      this.save(record); return this.public(record);
    }
    if (process.platform === "win32") {
      record.status = "error"; record.error = { code: "SUPERVISOR_UNAVAILABLE", message: "POSIX supervisor unavailable" }; record.finished_at = new Date().toISOString(); this.save(record); return this.public(record);
    }
    let child;
    try { child = this.spawn(process.execPath, [fileURLToPath(new URL("./job-supervisor.js", import.meta.url))], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] }); }
    catch { record.status = "error"; record.error = { code: "SUPERVISOR_UNAVAILABLE", message: "Unable to start supervisor" }; record.finished_at = new Date().toISOString(); this.save(record); return this.public(record); }
    let bytes = 0, result = null, requested = null, exited = false, started = false, stopWatchdog;
    const unavailable = () => { record.error = { code: "TERMINATION_UNAVAILABLE", message: "Termination not verified; process outcome is unknown" }; };
    const stop = why => {
      if (requested || exited || result) return;
      requested = why;
      stopWatchdog = setTimeout(() => { if (!result) { unavailable(); if (child.connected) child.disconnect(); } }, 2000);
      if (!child.connected) { unavailable(); return; }
      try { child.send({ type: "stop", reason: why }, err => { if (err && !result) unavailable(); }); } catch { unavailable(); }
    };
    handedOff = true;
    child.once("close", admission.release);
    this.active.set(record.job_id, { record, stop, reserve, cwd: decision.identities.cwd.canonical });
    this.storage.start(this.dir, () => [...this.active].map(([id, job]) => [id, job.cwd]));
    const timer = setTimeout(() => stop("timeout"), timeout_ms);
    const handshake = setTimeout(() => { if (!started && !result) { unavailable(); stop("error"); if (child.connected) child.disconnect(); } }, 5000);
    child.once("spawn", () => {
      try { child.send({ type: "start", executable, args, cwd: decision.identities.cwd.canonical, identities: decision.identities }, err => { if (err) { unavailable(); if (child.connected) child.disconnect(); } }); }
      catch { unavailable(); if (child.connected) child.disconnect(); }
    });
    child.on("message", message => {
      if (message?.type === "spawned" && !result && !exited) {
        started = true; clearTimeout(handshake);
        record.status = "running"; record.started_at = new Date().toISOString();
        try { this.save(record); } catch { stop("error"); record.error = { code: "STORAGE_FAILED", message: "Unable to store job status" }; }
      }
      else if (["result", "spawn_error", "admission_error", "error"].includes(message?.type) && !result) { result = message; clearTimeout(handshake); }
    });
    for (const stream of ["stdout", "stderr"]) child[stream].on("data", chunk => {
      const keep = chunk.subarray(0, Math.max(0, max_output_bytes - bytes)); bytes += keep.length;
      const newlyTruncated = keep.length < chunk.length && !record[`${stream}_truncated`];
      if (!keep.length && !newlyTruncated) return;
      record[stream] = Buffer.concat([Buffer.from(record[stream], "base64"), keep]).toString("base64");
      if (newlyTruncated) record[`${stream}_truncated`] = true;
      try { this.save(record); } catch { stop("error"); record.error = { code: "STORAGE_FAILED", message: "Unable to store job output" }; }
    });
    child.once("error", () => { record.error = { code: "SUPERVISOR_UNAVAILABLE", message: "Unable to start supervisor" }; });
    child.once("exit", () => {
      exited = true;
      const drain = setTimeout(() => { for (const s of ["stdout", "stderr"]) if (!child[s].destroyed) { record[`${s}_truncated`] = true; child[s].destroy(); } }, 200);
      child.once("close", () => clearTimeout(drain));
    });
    child.once("close", (_code, signal) => {
      clearTimeout(timer); clearTimeout(handshake); clearTimeout(stopWatchdog);
      if (!record.error && (!result || signal !== "SIGKILL" || result.type === "error")) unavailable();
      if (!record.error && result.type === "spawn_error") record.error = { code: "SPAWN_FAILED", message: "Unable to start executable" };
      if (!record.error && result.type === "admission_error") record.error = { code: "STORAGE_ADMISSION_DENIED", reason: "UNAVAILABLE", message: "Storage admission denied", ...decision, allowed: false, state: "UNAVAILABLE" };
      if (result?.type === "result") { record.exit_code = result.code; record.signal = result.signal; }
      record.status = record.error ? "error" : result.reason || (result.code === 0 ? "success" : "failed");
      record.finished_at = new Date().toISOString();
      let saved = false;
      try { this.save(record); saved = true; } catch { /* the last persisted state is reconciled on restart */ }
      this.active.delete(record.job_id);
      this.storage.snapshots.delete(record.job_id);
      if (!this.active.size) this.storage.stop();
      if (saved && record.status !== "interrupted" && record.error?.code !== "TERMINATION_UNAVAILABLE") this.finishedHere.set(record.job_id, digest(record));
      if (this.closed && !this.active.size) this.releaseLock();
    });
    return this.public(record);
    } finally {
      if (!handedOff) {
        admission.release();
        if (!this.active.size && this.lock) { this.releaseLock(); this.initialized = false; }
      }
    }
  }
}
