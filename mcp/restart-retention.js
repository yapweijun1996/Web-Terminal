import fs from "node:fs";
import path from "node:path";
const jobId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// This build has no authenticated, independently owned writer or verifier.
// Neither caller-supplied evidence nor opt-in can make it available.
export function restartRetentionPolicy({ optIn = false } = {}) {
  if (typeof optIn !== "boolean") throw Error("Invalid retention policy");
  return Object.freeze({ optIn, available: false, automaticDeletion: false, reason: optIn ? "TRUSTED_VERIFIER_UNAVAILABLE" : "POLICY_DISABLED" });
}

// Inventory is intentionally independent of JobManager.init(): no lock acquisition,
// record reconciliation, migration, creation, or deletion occurs.
export function previewLegacyMigration(dir, { limit = 1000 } = {}) {
  if (!path.isAbsolute(dir) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error("Invalid inventory arguments");
  const root = fs.lstatSync(dir);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid() || (root.mode & 0o077)) throw Error("Unsafe registry directory");
  const entries = []; let truncated = false;
  const iterator = fs.opendirSync(dir);
  try {
    let entry;
    while ((entry = iterator.readSync()) !== null) {
      if (entries.length === limit) { truncated = true; break; }
      const name = entry.name;
      if (name === ".lock") { entries.push({ name, reason: "LOCK_NOT_EVIDENCE" }); continue; }
      if (!name.endsWith(".json") || !jobId.test(name.slice(0, -5))) { entries.push({ name, reason: "UNRECOGNIZED_ENTRY" }); continue; }
      const file = path.join(dir, name);
      let reason = "UNTRUSTED_LEGACY_PROVENANCE";
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || st.size > 3000000) throw Error("unsafe");
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const opened = fs.fstatSync(fd);
          if (opened.dev !== st.dev || opened.ino !== st.ino || !opened.isFile() || opened.uid !== process.getuid() || (opened.mode & 0o077) || opened.size > 3000000) throw Error("unsafe");
          const buffer = Buffer.alloc(opened.size + 1);
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
          if (bytes !== opened.size) throw Error("changed");
          const record = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
          if (record.job_id !== name.slice(0, -5) || typeof record.stdout !== "string" || typeof record.stderr !== "string") throw Error("corrupt");
          if (!["success", "failed", "error", "timeout", "cancelled"].includes(record.status)) reason = "ACTIVE_OR_UNKNOWN_OUTCOME";
        } finally { fs.closeSync(fd); }
      } catch { reason = "CORRUPT_OR_UNSAFE"; }
      entries.push({ name, reason });
    }
  } finally { iterator.closeSync(); }
  return { mode: "preview_only", migrationAvailable: false, entries, truncated };
}
