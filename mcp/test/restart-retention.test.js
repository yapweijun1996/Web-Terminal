import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { JobManager } from "../jobs.js";
import { restartRetentionPolicy, previewLegacyMigration } from "../restart-retention.js";

const id = "12345678-1234-4123-8123-123456789abc";
const record = { job_id: id, status: "success", finished_at: "2000-01-01T00:00:00Z", stdout: "", stderr: "" };
const storageOptions = { statfs: () => ({ bsize: 1n, bavail: 100n * 1024n ** 3n }) };
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-golden-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function put(dir, data = record) { fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data), { mode: 0o600 }); }

test("forged same-UID key, signature, writer identity, version and replay never authorize restart deletion", async t => {
  const dir = fixture(t), key = "attacker-controlled-key";
  const forged = { ...record, owner: process.getuid(), writer: "trusted", version: 999, nonce: "replay", signature: createHmac("sha256", key).update(JSON.stringify(record)).digest("hex"), peer_uid: 0, attested: true };
  put(dir, forged);
  const m = new JobManager(dir, { storageOptions, maxJobs: 1, maxBytes: 100000, retentionMs: 1, restartRetentionOptIn: true });
  t.after(() => m.shutdown());
  assert.deepEqual(m.restartRetention, { optIn: true, available: false, automaticDeletion: false, reason: "TRUSTED_VERIFIER_UNAVAILABLE" });
  const result = await m.start({ executable: process.execPath, cwd: dir, max_output_bytes: 100 });
  assert.equal(result.error.code, "STORAGE_QUOTA");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`))), forged);
  assert.equal(previewLegacyMigration(dir).entries.find(e => e.name.endsWith(".json")).reason, "UNTRUSTED_LEGACY_PROVENANCE");
  assert.equal(restartRetentionPolicy().reason, "POLICY_DISABLED");
});

test("preview is read-only, bounded and refuses corrupt, symlink, unknown and temporary entries", t => {
  const dir = fixture(t), external = path.join(os.tmpdir(), `retention-target-${process.pid}-${Date.now()}`);
  fs.writeFileSync(external, "untouched", { mode: 0o600 }); t.after(() => fs.rmSync(external, { force: true }));
  put(dir, { ...record, status: "running" });
  const badId = "12345678-1234-4123-8123-123456789abd", linkId = "12345678-1234-4123-8123-123456789abe";
  fs.writeFileSync(path.join(dir, `${badId}.json`), "{", { mode: 0o600 });
  fs.symlinkSync(external, path.join(dir, `${linkId}.json`));
  fs.writeFileSync(path.join(dir, ".partial.tmp"), "x");
  const before = fs.readdirSync(dir).sort();
  const preview = previewLegacyMigration(dir), reasons = Object.fromEntries(preview.entries.map(e => [e.name, e.reason]));
  assert.equal(reasons[`${id}.json`], "ACTIVE_OR_UNKNOWN_OUTCOME");
  assert.equal(reasons[`${badId}.json`], "CORRUPT_OR_UNSAFE");
  assert.equal(reasons[`${linkId}.json`], "CORRUPT_OR_UNSAFE");
  assert.equal(reasons[".partial.tmp"], "UNRECOGNIZED_ENTRY");
  assert.equal(preview.migrationAvailable, false);
  assert.equal(previewLegacyMigration(dir, { limit: 1 }).truncated, true);
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.readFileSync(external, "utf8"), "untouched");
  assert.throws(() => previewLegacyMigration(path.join(dir, "..", "not-present")));
});

test("permission drift fails closed and does not inventory as trusted", t => {
  const dir = fixture(t); put(dir); fs.chmodSync(path.join(dir, `${id}.json`), 0o644);
  assert.equal(previewLegacyMigration(dir).entries[0].reason, "CORRUPT_OR_UNSAFE");
  const m = new JobManager(dir, { storageOptions }); assert.throws(() => m.init()); m.shutdown();
});

test("same-process completed record altered on disk cannot be evicted", async t => {
  const dir = fixture(t), m = new JobManager(dir, { storageOptions, maxJobs: 1, maxBytes: 100000, retentionMs: 1 });
  t.after(() => m.shutdown());
  const job = await m.start({ executable: process.execPath, args: ["-e", ""], cwd: dir, max_output_bytes: 100 });
  for (let n = 0; n < 300 && m.active.has(job.job_id); n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(m.active.has(job.job_id), false);
  const file = path.join(dir, `${job.job_id}.json`), changed = JSON.parse(fs.readFileSync(file));
  changed.finished_at = "2000-01-01T00:00:00Z"; changed.signature = "forged"; fs.writeFileSync(file, JSON.stringify(changed));
  const result = await m.start({ executable: process.execPath, cwd: dir, max_output_bytes: 100 });
  assert.equal(result.error.code, "STORAGE_QUOTA"); assert.deepEqual(JSON.parse(fs.readFileSync(file)), changed);
});
