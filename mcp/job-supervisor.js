import { spawn } from "node:child_process";
import { sameIdentity } from "./storage-safety.js";

// This process is the detached session and process-group leader. Its group ID
// cannot be reused until it exits, so only it may signal that group.
let child, reason = null, finished = false, childExited = false, timer;
process.on("SIGTERM", () => {});
function cleanup(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const killGroup = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); } };
  if (process.connected) {
    const fallback = setTimeout(killGroup, 500);
    try { process.send(result, () => { clearTimeout(fallback); killGroup(); }); } catch { clearTimeout(fallback); killGroup(); }
  } else killGroup();
}
function stop(why) {
  if (finished || reason || childExited) return;
  reason = why;
  if (!child) { cleanup({ type: "result", reason, code: null, signal: null }); return; }
  try { process.kill(-process.pid, "SIGTERM"); } catch { cleanup({ type: "error" }); return; }
  timer = setTimeout(() => cleanup({ type: "result", reason, code: null, signal: null }), 500);
}
process.on("disconnect", () => stop("interrupted"));
process.on("message", message => {
  if (message?.type === "stop") { stop(message.reason); return; }
  if (message?.type !== "start" || child || finished) return;
  try {
    if (!sameIdentity(message.identities?.cwd) || !sameIdentity(message.identities?.registry)) { cleanup({ type: "admission_error" }); return; }
    child = spawn(message.executable, message.args, { cwd: message.cwd, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.once("spawn", () => {
      if (!process.connected) { stop("interrupted"); return; }
      try { process.send({ type: "spawned" }, err => { if (err) stop("interrupted"); }); } catch { stop("interrupted"); }
    });
    child.once("error", () => cleanup({ type: "spawn_error" }));
    child.once("exit", (code, signal) => {
      childExited = true;
      const exitReason = reason;
      const result = () => ({ type: "result", reason: exitReason, code, signal });
      const drain = setTimeout(() => cleanup(result()), 200);
      child.once("close", () => {
        let pending = 2;
        const flushed = () => { if (--pending === 0) { clearTimeout(drain); cleanup(result()); } };
        process.stdout.write("", flushed); process.stderr.write("", flushed);
      });
    });
  } catch { cleanup({ type: "spawn_error" }); }
});
// A controller that fails before sending its configuration must not leak us.
setTimeout(() => { if (!child) cleanup({ type: "error" }); }, 5000).unref();
