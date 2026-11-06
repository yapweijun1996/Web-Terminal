import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { StorageSafety } from "./storage-safety.js";
import { storageReservations } from "./storage-reservations.js";

const safeString = z.string().refine((s) => !s.includes("\0"), "NUL is not allowed");
export const execInput = {
  executable: safeString.min(1).max(4096),
  args: z.array(safeString.max(8192)).max(128).default([]),
  cwd: safeString.min(1).max(4096).refine(path.isAbsolute, "cwd must be absolute"),
  timeout_ms: z.number().int().min(100).max(60000).default(10000),
  max_output_bytes: z.number().int().min(1).max(1048576).default(262144),
};
const schema = z.object(execInput).strict();
const MAX_CONCURRENT = 4;
let active = 0;
const children = new Set();
export function terminateExecutions() { for (const stop of children) stop("interrupted"); }
process.once("exit", terminateExecutions);

const defaultStorage = new StorageSafety();
export async function terminalExec(input, options = {}) {
  const started = performance.now();
  const result = { execution_id: randomUUID(), status: "error", exit_code: null,
    stdout: "", stderr: "", duration_ms: 0, stdout_truncated: false,
    stderr_truncated: false, signal: null, error: null };
  const finish = () => ({ ...result, duration_ms: Math.round(performance.now() - started) });
  const parsed = schema.safeParse(input);
  if (!parsed.success) { result.error = { code: "INVALID_PARAMETERS", message: "Invalid execution parameters" }; return finish(); }
  if (active >= MAX_CONCURRENT) { result.error = { code: "CONCURRENCY_LIMIT", message: "Execution capacity reached" }; return finish(); }
  active++;
  let release = null, handedOff = false;
  try {
    const { executable, args, cwd, timeout_ms, max_output_bytes } = parsed.data;
    try {
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      result.error = { code: "INVALID_CWD", message: "Working directory is unavailable or not a directory" };
      return finish();
    }
    const storage = options.storage ?? defaultStorage;
    const registry = options.registry ?? process.env.WEB_TERMINAL_JOB_DIR ?? path.join(os.homedir(), ".web-terminal-jobs");
    const admission = (options.reservations ?? storageReservations).acquire(storage, registry, cwd);
    const decision = admission.decision;
    release = admission.release;
    if (!decision.allowed) {
      result.error = { code: "STORAGE_ADMISSION_DENIED", reason: decision.state, message: "Storage admission denied", ...decision };
      return finish();
    }
    return await new Promise((resolve) => {
      let child;
      let timer;
      let forced = null;
      let outcome = null, exited = false, watchdog, settled = false;
      let bytes = 0;
      const buffers = { stdout: [], stderr: [] };
      const stop = (reason) => {
        if (forced || exited || outcome) return;
        forced = reason;
        if (child.connected) {
          try { child.send({ type: "stop", reason }, () => {}); } catch { /* close reports uncertainty */ }
        }
        watchdog = setTimeout(() => {
          if (child.connected) child.disconnect();
          for (const name of ["stdout", "stderr"]) child[name].destroy();
          complete(null, null);
        }, 2000);
      };
      const collect = (name, chunk) => {
        const remaining = Math.max(0, max_output_bytes - bytes);
        const kept = chunk.subarray(0, remaining);
        buffers[name].push(kept);
        bytes += kept.length;
        if (kept.length < chunk.length) { result[`${name}_truncated`] = true; stop("output_limit"); }
      };
      if (!storage.verify(decision)) {
        result.error = { code: "STORAGE_ADMISSION_DENIED", reason: "UNAVAILABLE", message: "Storage admission denied", ...decision, allowed: false, state: "UNAVAILABLE" };
        resolve(finish()); return;
      }
      try {
        if (process.platform === "win32") throw Error("POSIX supervisor unavailable");
        child = (options.spawn ?? spawn)(process.execPath, [fileURLToPath(new URL("./job-supervisor.js", import.meta.url))], { detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
      } catch {
        result.error = { code: "SUPERVISOR_UNAVAILABLE", message: "Unable to start supervisor" };
        resolve(finish()); return;
      }
      handedOff = true;
      child.once("close", () => release());
      children.add(stop);
      child.once("spawn", () => {
        try { child.send({ type: "start", executable, args, cwd: decision.identities.cwd.canonical, identities: decision.identities }, err => { if (err && child.connected) child.disconnect(); }); }
        catch { if (child.connected) child.disconnect(); }
      });
      child.on("message", message => { if (["result", "spawn_error", "admission_error", "error"].includes(message?.type) && !outcome) outcome = message; });
      child.stdout.on("data", (chunk) => collect("stdout", chunk));
      child.stderr.on("data", (chunk) => collect("stderr", chunk));
      child.once("error", () => { result.error = { code: "SUPERVISOR_UNAVAILABLE", message: "Unable to start supervisor" }; });
      child.once("exit", () => {
        exited = true;
        // An escaped descendant can retain a pipe after the process group dies.
        const drain = setTimeout(() => {
          for (const name of ["stdout", "stderr"]) {
            if (!child[name].destroyed) { result[`${name}_truncated`] = true; child[name].destroy(); }
          }
        }, 200);
        child.once("close", () => clearTimeout(drain));
      });
      timer = setTimeout(() => stop("timeout"), timeout_ms);
      const complete = (_code, signal) => {
        if (settled) return;
        settled = true;
        children.delete(stop);
        clearTimeout(timer);
        clearTimeout(watchdog);
        result.stdout = Buffer.concat(buffers.stdout).toString("utf8");
        result.stderr = Buffer.concat(buffers.stderr).toString("utf8");
        if (!result.error && (!outcome || signal !== "SIGKILL" || outcome.type === "error")) result.error = { code: "TERMINATION_UNAVAILABLE", message: "Termination not verified; process outcome is unknown" };
        if (!result.error && outcome.type === "spawn_error") result.error = { code: "SPAWN_FAILED", message: "Unable to start executable" };
        if (!result.error && outcome.type === "admission_error") result.error = { code: "STORAGE_ADMISSION_DENIED", reason: "UNAVAILABLE", message: "Storage admission denied", ...decision, allowed: false, state: "UNAVAILABLE" };
        if (outcome?.type === "result") {
          result.exit_code = outcome.code;
          result.signal = outcome.signal;
          if (outcome.reason) { result.exit_code = null; result.signal = "SIGKILL"; }
        }
        result.status = result.error ? "error" : forced === "output_limit" ? "output_limit" : outcome.reason === "interrupted" ? "failed" : outcome.reason || (outcome.code === 0 ? "success" : "failed");
        resolve(finish());
      };
      child.once("close", complete);
    });
  } finally { if (release && !handedOff) release(); active--; }
}
