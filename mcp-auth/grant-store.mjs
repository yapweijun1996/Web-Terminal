import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { MAX_GRANT_SECONDS, AUTH_CODE_TTL_MS } from "./grant-policy.mjs";
const label = "web-terminal-mcp-store/v1";
const hex = /^[a-f0-9]{64}$/;
function privatePath(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    !(directory ? stat.isDirectory() : stat.isFile())
  )
    throw Error("Unsafe authorization storage");
  return stat;
}
function atomicWrite(file, text) {
  const temp = file + "." + crypto.randomBytes(12).toString("hex") + ".tmp";
  let fd;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
function acquireLock(file) {
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  const create = () => {
    const fd = fs.openSync(file, flags, 0o600);
    try {
      fs.writeFileSync(fd, String(process.pid));
      fs.fsyncSync(fd);
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  try {
    return create();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const recovery = file + ".recovery";
  try {
    fs.mkdirSync(recovery, { mode: 0o700 });
  } catch {
    throw Error(
      "Authorization store locked; inspect existing writer before recovery",
    );
  }
  try {
    const before = privatePath(file),
      text = fs.readFileSync(file, "utf8");
    if (!/^[1-9][0-9]{0,9}$/.test(text))
      throw Error("Authorization store locked");
    try {
      process.kill(Number(text), 0);
      throw Error("Authorization store locked");
    } catch (error) {
      if (error.code !== "ESRCH") throw Error("Authorization store locked");
    }
    const after = privatePath(file);
    if (before.ino !== after.ino || before.dev !== after.dev)
      throw Error("Authorization store locked");
    fs.unlinkSync(file);
    return create();
  } finally {
    fs.rmdirSync(recovery);
  }
}
export class GrantStore {
  constructor({ stateDir, keyFile, resource, issuer } = {}) {
    this.resource = resource;
    this.issuer = issuer;
    this.failed = false;
    this.clients = new Map();
    this.grants = new Map();
    if (!stateDir && !keyFile) {
      this.key = crypto.randomBytes(32);
      return;
    }
    if (
      !path.isAbsolute(stateDir || "") ||
      !path.isAbsolute(keyFile || "") ||
      path.dirname(keyFile) === stateDir ||
      keyFile.startsWith(stateDir + path.sep)
    )
      throw Error("Separate absolute state and key paths required");
    privatePath(stateDir, true);
    privatePath(path.dirname(keyFile), true);
    this.file = path.join(stateDir, "grants.json");
    this.lock = path.join(stateDir, "writer.lock");
    this.lockFd = acquireLock(this.lock);
    try {
      const exists = (() => {
        try {
          fs.lstatSync(this.file);
          return true;
        } catch (error) {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      })();
      if (exists) privatePath(this.file);
      const keyParent = fs.realpathSync(path.dirname(keyFile)),
        stateRoot = fs.realpathSync(stateDir);
      if (keyParent === stateRoot || keyParent.startsWith(stateRoot + path.sep))
        throw Error("Separate state and key paths required");
      if (!fs.existsSync(keyFile)) {
        if (exists) throw Error("Authorization key missing");
        const fd = fs.openSync(
          keyFile,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, crypto.randomBytes(32));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
      const keyDirectory = fs.openSync(
        path.dirname(keyFile),
        fs.constants.O_RDONLY,
      );
      try {
        fs.fsyncSync(keyDirectory);
      } finally {
        fs.closeSync(keyDirectory);
      }
      privatePath(keyFile);
      this.key = fs.readFileSync(keyFile);
      if (this.key.length !== 32) throw Error("Invalid authorization key");
      if (exists) {
        if (privatePath(this.file).size > 2 * 1024 * 1024)
          throw Error("Authorization store oversized");
        const envelope = JSON.parse(fs.readFileSync(this.file, "utf8"));
        if (
          envelope.version !== 1 ||
          typeof envelope.payload !== "string" ||
          typeof envelope.mac !== "string" ||
          !hex.test(envelope.mac) ||
          this.digest("store-integrity", envelope.payload) !== envelope.mac
        )
          throw Error("Authorization store integrity failure");
        const data = JSON.parse(envelope.payload);
        if (data.resource !== this.resource || data.issuer !== this.issuer)
          throw Error("Authorization resource changed");
        if (
          !Array.isArray(data.clients) ||
          !Array.isArray(data.grants) ||
          data.clients.length > 100 ||
          data.grants.length > 1000
        )
          throw Error("Invalid authorization state");
        for (const [id, value] of data.clients) {
          if (
            !/^[A-Za-z0-9_-]{43}$/.test(id) ||
            !value ||
            typeof value.name !== "string" ||
            !Number.isSafeInteger(value.registeredAt) ||
            typeof value.approved !== "boolean" ||
            !Array.isArray(value.redirects) ||
            !value.redirects.length ||
            value.redirects.some((x) => typeof x !== "string")
          )
            throw Error("Invalid client state");
          this.clients.set(id, value);
        }
        for (const [id, value] of data.grants) {
          if (
            !/^[A-Za-z0-9_-]{43}$/.test(id) ||
            !value ||
            typeof value.clientId !== "string" ||
            typeof value.clientName !== "string" ||
            typeof value.resource !== "string" ||
            !Number.isSafeInteger(value.grantedAt) ||
            !Number.isSafeInteger(value.expires) ||
            value.expires <= value.grantedAt ||
            value.expires - value.grantedAt > MAX_GRANT_SECONDS * 1000 ||
            value.resource !== this.resource ||
            (value.tokenDigest !== null && !hex.test(value.tokenDigest))
          )
            throw Error("Invalid grant state");
          this.grants.set(id, value);
        }
      } else this.persist();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  ready() {
    if (this.failed) throw Error("Authorization persistence unavailable");
  }
  digest(purpose, value) {
    this.ready();
    return crypto
      .createHmac("sha256", this.key)
      .update(label + "\0" + purpose + "\0")
      .update(value)
      .digest("hex");
  }
  persist() {
    this.ready();
    if (!this.file) return;
    try {
      const payload = JSON.stringify({
        resource: this.resource,
        issuer: this.issuer,
        clients: [...this.clients],
        grants: [...this.grants],
      });
      atomicWrite(
        this.file,
        JSON.stringify({
          version: 1,
          payload,
          mac: this.digest("store-integrity", payload),
        }),
      );
    } catch {
      this.failed = true;
      throw Error("Authorization persistence unavailable");
    }
  }
  client(id) {
    this.ready();
    return this.clients.get(id);
  }
  addClient(id, value) {
    this.ready();
    this.prune();
    if (this.clients.size >= 100) {
      const oldest = [...this.clients].find(([, client]) => !client.approved);
      if (!oldest) throw Error("Client capacity reached");
      this.clients.delete(oldest[0]);
    }
    this.clients.set(id, {
      ...value,
      registeredAt: Date.now(),
      approved: false,
    });
    this.persist();
  }
  prune() {
    this.ready();
    let changed = false;
    for (const [id, client] of this.clients)
      if (!client.approved && client.registeredAt + 86400000 <= Date.now()) {
        this.clients.delete(id);
        changed = true;
      }
    for (const [id, grant] of this.grants)
      if (
        grant.expires <= Date.now() ||
        (grant.tokenDigest === null &&
          grant.grantedAt + AUTH_CODE_TTL_MS <= Date.now())
      ) {
        this.grants.delete(id);
        changed = true;
      }
    if (changed) this.persist();
  }
  createGrant(value) {
    this.prune();
    if (this.grants.size >= 1000) throw Error("Grant capacity reached");
    const client = this.clients.get(value.clientId);
    if (!client) throw Error("Client unavailable");
    client.approved = true;
    const id = crypto.randomBytes(32).toString("base64url");
    this.grants.set(id, { ...value, tokenDigest: null });
    this.persist();
    return id;
  }
  bindToken(id, token) {
    this.prune();
    const grant = this.grants.get(id);
    if (!grant || grant.expires <= Date.now() || grant.tokenDigest !== null)
      throw Error("Grant unavailable");
    grant.tokenDigest = this.digest("access-token", token);
    this.persist();
    return grant;
  }
  validToken(token) {
    this.prune();
    const digest = this.digest("access-token", token);
    return [...this.grants.values()].some(
      (grant) => grant.tokenDigest === digest,
    );
  }
  revokeToken(token) {
    this.ready();
    const digest = this.digest("access-token", token);
    for (const [id, grant] of this.grants)
      if (grant.tokenDigest === digest) {
        this.grants.delete(id);
        this.persist();
        return;
      }
  }
  revokeGrant(id) {
    this.ready();
    if (this.grants.delete(id)) this.persist();
  }
  list() {
    this.prune();
    return [...this.grants].map(([grantId, value]) => ({
      grantId,
      clientName: value.clientName,
      grantedAt: value.grantedAt,
      expires: value.expires,
      status: value.tokenDigest === null ? "pending" : "active",
    }));
  }
  close() {
    if (this.lockFd !== undefined) {
      fs.closeSync(this.lockFd);
      this.lockFd = undefined;
      fs.unlinkSync(this.lock);
    }
  }
}
