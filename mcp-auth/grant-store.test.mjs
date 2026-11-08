import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { GrantStore } from "./grant-store.mjs";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grant-store-"));
  fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state"),
    keyDir = path.join(root, "keys");
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.mkdirSync(keyDir, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    stateDir,
    keyFile: path.join(keyDir, "master.key"),
    resource: "https://mcp.example.test/mcp",
    issuer: "https://mcp.example.test",
  };
}
const random = () => crypto.randomBytes(32).toString("base64url");
function grant(store) {
  const clientId = random();
  store.addClient(clientId, {
    name: "Fixture",
    redirects: ["https://client.example.test/cb"],
  });
  const now = Date.now();
  return {
    clientId,
    id: store.createGrant({
      clientId,
      clientName: "Fixture",
      resource: store.resource,
      grantedAt: now,
      expires: now + 30 * 86400000,
    }),
  };
}
test("client and keyed token grant survive restart; revocation remains durable", (t) => {
  const config = fixture(t);
  let store = new GrantStore(config);
  const { id, clientId } = grant(store),
    token = random();
  const issued = store.bindToken(id, token),
    expiry = issued.expires;
  assert.equal(store.validToken(token), true);
  const text = fs.readFileSync(
    path.join(config.stateDir, "grants.json"),
    "utf8",
  );
  assert.equal(text.includes(token), false);
  assert.equal(fs.statSync(config.keyFile).mode & 0o777, 0o600);
  assert.equal(
    fs.statSync(path.join(config.stateDir, "grants.json")).mode & 0o777,
    0o600,
  );
  store.close();
  store = new GrantStore(config);
  assert.equal(store.client(clientId).name, "Fixture");
  assert.equal(store.validToken(token), true);
  assert.equal(store.list()[0].expires, expiry);
  store.revokeToken(token);
  store.close();
  store = new GrantStore(config);
  assert.equal(store.validToken(token), false);
  store.close();
});
test("exact expiry and domain separated HMAC reject cross-purpose token", (t) => {
  const config = fixture(t),
    store = new GrantStore(config);
  try {
    const { id } = grant(store),
      token = random();
    store.bindToken(id, token);
    assert.notEqual(
      store.digest("access-token", token),
      store.digest("authorization-code", token),
    );
    const expires = store.list()[0].expires,
      clock = Date.now;
    try {
      Date.now = () => expires;
      assert.equal(store.validToken(token), false);
    } finally {
      Date.now = clock;
    }
  } finally {
    store.close();
  }
});
test("single writer and resource binding fail closed", (t) => {
  const config = fixture(t),
    store = new GrantStore(config);
  assert.throws(() => new GrantStore(config), /locked/);
  store.close();
  assert.throws(
    () =>
      new GrantStore({ ...config, resource: "https://other.example.test/mcp" }),
    /resource/,
  );
  const reopened = new GrantStore(config);
  reopened.close();
});
test("tampered envelope, wrong or missing key fail closed", (t) => {
  const config = fixture(t);
  let store = new GrantStore(config);
  grant(store);
  store.close();
  const file = path.join(config.stateDir, "grants.json"),
    backup = fs.readFileSync(file);
  const envelope = JSON.parse(backup);
  envelope.payload = envelope.payload.replace("Fixture", "Tampered");
  fs.writeFileSync(file, JSON.stringify(envelope));
  assert.throws(() => new GrantStore(config), /integrity/);
  fs.writeFileSync(file, backup);
  const key = fs.readFileSync(config.keyFile);
  fs.writeFileSync(config.keyFile, crypto.randomBytes(32));
  assert.throws(() => new GrantStore(config), /integrity/);
  fs.writeFileSync(config.keyFile, key);
  fs.unlinkSync(config.keyFile);
  assert.throws(() => new GrantStore(config), /key missing/);
});
test("unsafe modes, symlinks and key inside snapshot are rejected", (t) => {
  const config = fixture(t);
  fs.chmodSync(config.stateDir, 0o755);
  assert.throws(() => new GrantStore(config), /Unsafe/);
  fs.chmodSync(config.stateDir, 0o700);
  assert.throws(
    () =>
      new GrantStore({ ...config, keyFile: path.join(config.stateDir, "key") }),
    /Separate/,
  );
  const keyParent = path.dirname(config.keyFile);
  assert.throws(
    () =>
      new GrantStore({
        ...config,
        keyFile: keyParent + "/../state/inside.key",
      }),
    /Separate/,
  );
  const alias = path.join(keyParent, "state-alias");
  fs.symlinkSync(config.stateDir, alias);
  assert.throws(
    () =>
      new GrantStore({ ...config, keyFile: path.join(alias, "inside.key") }),
    /Unsafe|Separate/,
  );
  fs.symlinkSync("/nonexistent", path.join(config.stateDir, "grants.json"));
  assert.throws(() => new GrantStore(config), /Unsafe/);
  fs.unlinkSync(path.join(config.stateDir, "grants.json"));
  let store = new GrantStore(config);
  store.close();
  fs.chmodSync(config.keyFile, 0o644);
  assert.throws(() => new GrantStore(config), /Unsafe/);
  fs.chmodSync(config.keyFile, 0o600);
  const original = config.keyFile + ".original";
  fs.renameSync(config.keyFile, original);
  fs.symlinkSync(original, config.keyFile);
  assert.throws(() => new GrantStore(config), /Unsafe/);
});
test("persistence failure disables authorization instead of memory fallback", (t) => {
  const config = fixture(t),
    store = new GrantStore(config);
  try {
    const { id } = grant(store),
      token = random();
    store.bindToken(id, token);
    fs.renameSync(config.stateDir, config.stateDir + ".moved");
    assert.throws(() => store.revokeToken(token), /persistence/);
    assert.throws(() => store.validToken(token), /persistence/);
    fs.renameSync(config.stateDir + ".moved", config.stateDir);
  } finally {
    store.close();
  }
});

test("dead writer lock recovery preserves live and malformed locks", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const config = fixture(t),
    lock = path.join(config.stateDir, "writer.lock");
  const deadPid = execFileSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.pid))"],
    { encoding: "utf8" },
  );
  fs.writeFileSync(lock, deadPid, { mode: 0o600 });
  const store = new GrantStore(config);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
  store.close();
  fs.writeFileSync(lock, "malformed", { mode: 0o600 });
  assert.throws(() => new GrantStore(config), /locked/);
  assert.equal(fs.readFileSync(lock, "utf8"), "malformed");
  fs.unlinkSync(lock);
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
  assert.throws(() => new GrantStore(config), /locked/);
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid));
});

test("anonymous registration churn cannot evict owner-approved clients or block fresh registration", (t) => {
  const config = fixture(t);
  let store = new GrantStore(config);
  const { clientId } = grant(store);
  let newest;
  for (let index = 0; index < 150; index++) {
    newest = random();
    store.addClient(newest, {
      name: "Unapproved",
      redirects: ["https://client.example.test/cb"],
    });
  }
  assert.equal(store.clients.size, 100);
  assert.equal(store.client(clientId).approved, true);
  assert.equal(store.client(newest).approved, false);
  store.close();
  store = new GrantStore(config);
  assert.equal(store.client(clientId).approved, true);
  assert.equal(store.client(newest).approved, false);
  const clock = Date.now;
  try {
    Date.now = () => clock() + 86400001;
    store.prune();
    assert.equal(store.client(newest), undefined);
    assert.ok(store.client(clientId));
  } finally {
    Date.now = clock;
    store.close();
  }
});

test("unissued pending grants expire with the shared authorization-code deadline", async (t) => {
  const { AUTH_CODE_TTL_MS } = await import("./grant-policy.mjs");
  const config = fixture(t),
    store = new GrantStore(config);
  try {
    const { id } = grant(store),
      second = grant(store).id,
      token = random();
    store.bindToken(second, token);
    const clock = Date.now,
      issued = store.list().find((value) => value.grantId === id);
    try {
      Date.now = () => issued.grantedAt + AUTH_CODE_TTL_MS;
      store.prune();
      assert.equal(
        store.list().some((value) => value.grantId === id),
        false,
      );
      assert.equal(store.validToken(token), true);
      assert.throws(() => store.bindToken(id, random()), /unavailable/);
    } finally {
      Date.now = clock;
    }
  } finally {
    store.close();
  }
});

test("verified token projection exposes only grant identity and absolute expiry", t => {
  const store = new GrantStore(fixture(t));
  try {
    const { id } = grant(store), token = random();
    const issued = store.bindToken(id, token);
    const projection = store.grantForToken(token);
    assert.deepEqual(projection, { id, expires: issued.expires });
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(store.grantForToken("unknown-token"), null);
    assert.equal(store.revokeToken(token), id);
    assert.equal(store.grantForToken(token), null);
    assert.equal(store.revokeToken(token), null);
  } finally { store.close(); }
});
