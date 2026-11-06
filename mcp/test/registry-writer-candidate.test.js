import test from "node:test";
import assert from "node:assert/strict";
import { parseRequest, simulateTransition, MAX_REQUEST_BYTES } from "../registry-writer-protocol.js";
import { RegistryWriterCandidate } from "../registry-writer-service.js";
import { MacOSTrustedTransport } from "../registry-writer-transport.js";
const job = "12345678-1234-4123-8123-123456789abc", instance = "22345678-1234-4123-8123-123456789abc";
const request = { version: 1, type: "outcome", request_id: instance, job_id: job, nonce: "a".repeat(64) };
const encode = x => Buffer.from(JSON.stringify(x));
test("candidate rejects spoofed identities and never authorizes a channel", async () => {
  const service = new RegistryWriterCandidate({ uid: 0, verified: true });
  await assert.rejects(service.handle(encode(request), { uid: 0, verified: true }), { code: "TRUSTED_VERIFIER_UNAVAILABLE" });
  await assert.rejects(new MacOSTrustedTransport().authorizeChannel({ uid: 0 }), { code: "TRUSTED_VERIFIER_UNAVAILABLE" });
});
test("bounded closed protocol rejects delete, evidence and malformed frames", () => {
  for (const input of [Buffer.alloc(MAX_REQUEST_BYTES + 1), Buffer.from([255]), Buffer.from("{"), encode({ ...request, type: "delete" }), encode({ ...request, stdout: "done" }), encode({ ...request, version: 2 }), encode({ ...request, job_id: 42 })]) assert.throws(() => parseRequest(input));
  assert.deepEqual(parseRequest(encode(request)), request);
});
test("simulation rejects replay, stale nonce, conflicting supervisor and unknown-to-terminal transition", () => {
  const initial = { job_id: job, instance_id: instance, sequence: 0, phase: "running", nonces: [] };
  const event = { job_id: job, instance_id: instance, sequence: 1, nonce: "b".repeat(64), phase: "unknown" };
  const next = simulateTransition(initial, event);
  assert.throws(() => simulateTransition(next, event), { code: "REPLAY_OR_ORDER" });
  assert.throws(() => simulateTransition(next, { ...event, sequence: 2 }), { code: "REPLAY_OR_ORDER" });
  assert.throws(() => simulateTransition(initial, { ...event, instance_id: job }), { code: "INSTANCE_CONFLICT" });
  assert.throws(() => simulateTransition(next, { ...event, nonce: "c".repeat(64), sequence: 2, phase: "terminal" }), { code: "INVALID_TRANSITION" });
});
