import test from "node:test";
import assert from "node:assert/strict";
import { terminalExec, terminateExecutions } from "../exec.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = (code, options = {}) => terminalExec({ executable: process.execPath, args: ["-e", code], cwd: process.cwd(), ...options });

test("changed path identity at spawn boundary denies execution", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-path-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "marker"); let checks = 0;
  const storage = { decision: () => ({ allowed: true, state: "NORMAL", identities: { cwd: { canonical: dir } } }), verify: () => ++checks === 1 };
  const result = await terminalExec({ executable: process.execPath, args: ["-e", "require('fs').writeFileSync(process.argv[1], 'bad')", marker], cwd: dir }, { storage, registry: dir });
  assert.equal(result.error.code, "STORAGE_ADMISSION_DENIED");
  assert.equal(result.error.reason, "UNAVAILABLE"); assert.equal(fs.existsSync(marker), false);
});

test("captures stdout, stderr and nonzero exit", async () => {
  const ok = await run("process.stdout.write('ok'); process.stderr.write('warning')");
  assert.equal(ok.status, "success");
  assert.equal(ok.stdout, "ok"); assert.equal(ok.stderr, "warning"); assert.equal(ok.exit_code, 0);
  assert.ok(ok.execution_id); assert.ok(ok.duration_ms >= 0);
  const failed = await run("process.exit(7)");
  assert.equal(failed.status, "failed"); assert.equal(failed.exit_code, 7);
});

test("arguments are literal and never interpreted by a shell", async () => {
  const value = "$(echo unsafe); * | &";
  const result = await terminalExec({ executable: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", value], cwd: process.cwd() });
  assert.equal(result.stdout, value); assert.equal(result.status, "success");
});

test("timeout kills the process group, including descendants holding pipes", async () => {
  const result = await run("require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'}); setInterval(()=>{},1000)", { timeout_ms: 150 });
  assert.equal(result.status, "timeout"); assert.equal(result.signal, "SIGKILL"); assert.ok(result.duration_ms < 3000);
});

test("invalid directory, invalid parameters and spawn failure are distinct", async () => {
  assert.equal((await run("", { cwd: "/nonexistent-mcp-test-dir" })).error.code, "INVALID_CWD");
  assert.equal((await run("", { cwd: "relative" })).error.code, "INVALID_PARAMETERS");
  const missing = await terminalExec({ executable: "/nonexistent-mcp-executable", cwd: process.cwd() });
  assert.equal(missing.error.code, "SPAWN_FAILED"); assert.equal(missing.status, "error");
});

test("combined output cap stops process and identifies truncated stream", async () => {
  const result = await run("process.stdout.write('a'.repeat(20000)); setInterval(()=>{},1000)", { max_output_bytes: 100 });
  assert.equal(result.status, "output_limit"); assert.equal(Buffer.byteLength(result.stdout), 100);
  assert.equal(result.stdout_truncated, true); assert.equal(result.stderr_truncated, false);
});

test("concurrency limit rejects excess work and releases capacity", async () => {
  const jobs = Array.from({ length: 4 }, () => run("setTimeout(()=>{},300)"));
  const denied = await run("");
  assert.equal(denied.error.code, "CONCURRENCY_LIMIT");
  assert.ok((await Promise.all(jobs)).every((r) => r.status === "success"));
  assert.equal((await run("")).status, "success");
});

test("supervisor exit and timeout races never signal a controller PID", async () => {
  const originalKill = process.kill; const signals = [];
  process.kill = (...args) => { signals.push(args); throw Error("controller must not signal"); };
  try {
    const fake = scenario => () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
      child.disconnect = () => { child.connected = false; };
      child.send = (message, cb) => {
        cb?.();
        if (message.type === "start" && scenario === "exit") setImmediate(() => {
          child.emit("message", { type: "result", code: 0, signal: null, reason: null });
          child.emit("exit", null, "SIGKILL");
          setTimeout(() => child.emit("close", null, "SIGKILL"), 150);
        });
        if (message.type === "stop" && scenario === "timeout") setImmediate(() => {
          child.emit("message", { type: "result", code: null, signal: "SIGTERM", reason: "timeout" });
          child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL");
        });
      };
      setImmediate(() => child.emit("spawn")); return child;
    };
    const input = { executable: "x", cwd: process.cwd(), timeout_ms: 100 };
    assert.equal((await terminalExec(input, { spawn: fake("exit") })).status, "success");
    assert.equal((await terminalExec(input, { spawn: fake("timeout") })).status, "timeout");
    assert.deepEqual(signals, []);
  } finally { process.kill = originalKill; }
});

test("crashed supervisor fails closed", async () => {
  const fake = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
    child.send = (_message, cb) => cb?.(); child.disconnect = () => { child.connected = false; };
    setImmediate(() => { child.emit("spawn"); child.emit("exit", 1, null); child.emit("close", 1, null); }); return child;
  };
  const result = await terminalExec({ executable: "x", cwd: process.cwd() }, { spawn: fake });
  assert.equal(result.error.code, "TERMINATION_UNAVAILABLE");
});

test("shutdown stops executions and SIGTERM-resistant descendants cannot hold pipes", async () => {
  const script = "process.on('SIGTERM',()=>{}); require('child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'}); console.log('ready'); setInterval(()=>{},1000)";
  const pending = run(script, { timeout_ms: 5000 });
  await new Promise(resolve => setTimeout(resolve, 300)); terminateExecutions();
  const result = await pending;
  assert.equal(result.status, "failed"); assert.equal(result.signal, "SIGKILL"); assert.ok(result.duration_ms < 3000);
});

test("stderr output cap stops execution", async () => {
  const result = await run("process.stderr.write('z'.repeat(20000)); setInterval(()=>{},1000)", { max_output_bytes: 100 });
  assert.equal(result.status, "output_limit"); assert.equal(Buffer.byteLength(result.stderr), 100); assert.equal(result.stderr_truncated, true);
});
