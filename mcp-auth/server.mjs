import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
const random = () => crypto.randomBytes(32).toString("base64url");
const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("base64url");
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 16384) throw Error("body");
  }
  return data;
}
function validHttps(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw Error("HTTPS URL required");
  return u;
}
export function createAccessVerifier(config, keys) {
  const accessIssuer = validHttps(config.accessIssuer).origin;
  if (!config.accessAudience) throw Error("Access audience required");
  const jwks =
    keys ||
    createRemoteJWKSet(new URL("/cdn-cgi/access/certs", accessIssuer), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    });
  return async (req) => {
    const { payload } = await jwtVerify(
      req.headers["cf-access-jwt-assertion"] || "",
      jwks,
      {
        issuer: accessIssuer,
        audience: config.accessAudience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "sub", "email"],
      },
    );
    return !config.ownerEmail || payload.email === config.ownerEmail;
  };
}
export function createGateway(config, verifyOwner) {
  const resource = validHttps(config.publicUrl).href,
    issuer = new URL(resource).origin,
    approval = validHttps(config.approvalUrl),
    publicHost = new URL(resource).host;
  const redirects = new Set(
    config.redirectUris.map((value) => validHttps(value).href),
  );
  if (!redirects.size) throw Error("Redirect allowlist required");
  if (!verifyOwner) verifyOwner = createAccessVerifier(config);
  const clients = new Map(),
    pending = new Map(),
    codes = new Map(),
    tokens = new Map();
  const prune = () => {
    for (const map of [clients, pending, codes, tokens])
      for (const [k, v] of map) if (v.expires <= Date.now()) map.delete(k);
  };
  let budget = 0,
    reset = Date.now() + 60000;
  const metadata = {
    issuer,
    authorization_endpoint: issuer + "/oauth/authorize",
    token_endpoint: issuer + "/oauth/token",
    registration_endpoint: issuer + "/oauth/register",
    revocation_endpoint: issuer + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["terminal"],
  };
  const protectedMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["terminal"],
    bearer_methods_supported: ["header"],
  };
  const fail = (res, status = 400) =>
    send(res, status, {
      error: status === 401 ? "invalid_token" : "invalid_request",
    });
  const publicServer = http.createServer(async (req, res) => {
    try {
      prune();
      if (Date.now() > reset) {
        budget = 0;
        reset = Date.now() + 60000;
      }
      if (++budget > 600) return send(res, 429, { error: "rate_limited" });
      if (req.headers.host !== publicHost) return fail(res);
      const url = new URL(req.url, issuer);
      if (
        req.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          "/.well-known/oauth-protected-resource/mcp",
        ].includes(url.pathname)
      )
        return send(res, 200, protectedMetadata);
      if (
        req.method === "GET" &&
        url.pathname === "/.well-known/oauth-authorization-server"
      )
        return send(res, 200, metadata);
      if (req.method === "POST" && url.pathname === "/oauth/register") {
        if (!(req.headers["content-type"] || "").startsWith("application/json"))
          return fail(res);
        const input = JSON.parse(await body(req));
        if (
          !Array.isArray(input.redirect_uris) ||
          !input.redirect_uris.length ||
          input.redirect_uris.length > 5 ||
          input.redirect_uris.some((x) => !redirects.has(x)) ||
          clients.size >= 100
        )
          return fail(res);
        if (
          input.token_endpoint_auth_method &&
          input.token_endpoint_auth_method !== "none"
        )
          return fail(res);
        const client_id = random();
        clients.set(client_id, {
          redirects: new Set(input.redirect_uris),
          name: String(input.client_name || "MCP client").slice(0, 80),
          expires: Date.now() + 86400000,
        });
        return send(res, 201, {
          client_id,
          redirect_uris: input.redirect_uris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
        });
      }
      if (req.method === "GET" && url.pathname === "/oauth/authorize") {
        const q = url.searchParams,
          client = clients.get(q.get("client_id"));
        if (
          [...new Set(q.keys())].some((k) => q.getAll(k).length !== 1) ||
          !client ||
          !client.redirects.has(q.get("redirect_uri")) ||
          q.get("response_type") !== "code" ||
          q.get("code_challenge_method") !== "S256" ||
          !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") || "") ||
          q.get("resource") !== resource ||
          (q.get("scope") && q.get("scope") !== "terminal") ||
          (q.get("state") || "").length > 1024 ||
          pending.size >= 100
        )
          return fail(res);
        const id = random();
        pending.set(id, {
          clientId: q.get("client_id"),
          redirect: q.get("redirect_uri"),
          challenge: q.get("code_challenge"),
          state: q.get("state"),
          name: client.name,
          csrf: random(),
          expires: Date.now() + 300000,
        });
        const location = new URL(approval);
        location.searchParams.set("request", id);
        return send(res, 302, "", { Location: location.href });
      }
      if (req.method === "POST" && url.pathname === "/oauth/token") {
        if (
          !(req.headers["content-type"] || "").startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          return fail(res);
        const q = new URLSearchParams(await body(req)),
          record = codes.get(q.get("code"));
        codes.delete(q.get("code"));
        if (
          [...new Set(q.keys())].some((k) => q.getAll(k).length !== 1) ||
          q.get("grant_type") !== "authorization_code" ||
          !record ||
          record.clientId !== q.get("client_id") ||
          record.redirect !== q.get("redirect_uri") ||
          q.get("resource") !== resource ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(q.get("code_verifier") || "") ||
          hash(q.get("code_verifier")) !== record.challenge ||
          tokens.size >= 1000
        )
          return fail(res);
        const access_token = random();
        tokens.set(hash(access_token), { expires: Date.now() + 3600000 });
        return send(res, 200, {
          access_token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: "terminal",
        });
      }
      if (req.method === "POST" && url.pathname === "/oauth/revoke") {
        if (
          !(req.headers["content-type"] || "").startsWith(
            "application/x-www-form-urlencoded",
          )
        )
          return fail(res);
        const q = new URLSearchParams(await body(req));
        tokens.delete(hash(q.get("token") || ""));
        return send(res, 200, {});
      }
      if (url.pathname === "/mcp") {
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
          req.headers.authorization || "",
        );
        if (!match || !tokens.has(hash(match[1])))
          return send(
            res,
            401,
            { error: "invalid_token" },
            {
              "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        if (req.method !== "POST")
          return send(
            res,
            405,
            { error: "method_not_allowed" },
            { Allow: "POST" },
          );
        if (Number(req.headers["content-length"] || 0) > 1048576)
          return send(res, 413, { error: "request_too_large" });
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 1048576)
            return send(res, 413, { error: "request_too_large" });
          chunks.push(chunk);
        }
        const headers = {
          "content-type": req.headers["content-type"] || "application/json",
          accept: req.headers.accept || "application/json, text/event-stream",
          "content-length": length,
        };
        if (req.headers["mcp-protocol-version"])
          headers["mcp-protocol-version"] = req.headers["mcp-protocol-version"];
        const upstream = http.request(
          {
            socketPath: config.upstreamSocket,
            path: "/mcp",
            method: "POST",
            headers,
          },
          (response) => {
            res.writeHead(response.statusCode, {
              "Content-Type":
                response.headers["content-type"] || "application/json",
              "Cache-Control": "no-store",
            });
            response.pipe(res);
          },
        );
        upstream.setTimeout(15000, () => upstream.destroy());
        upstream.on("error", () => {
          if (!res.headersSent)
            send(res, 502, { error: "upstream_unavailable" });
          else res.destroy();
        });
        upstream.end(Buffer.concat(chunks));
        return;
      }
      return send(res, 404, { error: "not_found" });
    } catch {
      return fail(res);
    }
  });
  const approvalServer = http.createServer(async (req, res) => {
    try {
      prune();
      if (
        req.headers.host !== approval.host ||
        new URL(req.url, approval).pathname !== approval.pathname
      )
        return fail(res);
      if (!(await verifyOwner(req))) return fail(res, 401);
      if (req.method === "GET") {
        const id = new URL(req.url, approval).searchParams.get("request"),
          record = pending.get(id);
        if (!record) return fail(res);
        return send(
          res,
          200,
          `<!doctype html><meta name="viewport" content="width=device-width"><title>Allow terminal control</title><h1>Allow terminal control?</h1><p>${escape(
            record.name,
          )} will be able to read and type in the same terminal windows you see. Access expires after one hour.</p><p>Return address: ${escape(
            record.redirect,
          )}</p><form method="post"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${
            record.csrf
          }"><button name="decision" value="allow">Allow for one hour</button><button name="decision" value="deny">Deny</button></form>`,
          {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
          },
        );
      }
      if (
        req.method !== "POST" ||
        req.headers.origin !== approval.origin ||
        !(req.headers["content-type"] || "").startsWith(
          "application/x-www-form-urlencoded",
        )
      )
        return fail(res);
      const q = new URLSearchParams(await body(req)),
        record = pending.get(q.get("request"));
      if (!record || record.csrf !== q.get("csrf")) return fail(res);
      pending.delete(q.get("request"));
      const location = new URL(record.redirect);
      if (record.state !== null)
        location.searchParams.set("state", record.state);
      if (q.get("decision") === "allow") {
        const code = random();
        codes.set(code, { ...record, expires: Date.now() + 60000 });
        location.searchParams.set("code", code);
      } else location.searchParams.set("error", "access_denied");
      return send(res, 302, "", { Location: location.href });
    } catch {
      return fail(res, 401);
    }
  });
  for (const server of [publicServer, approvalServer]) {
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 64;
  }
  return { publicServer, approvalServer };
}
export function listenPrivate(server, socket) {
  if (!path.isAbsolute(socket)) throw Error("Absolute socket required");
  const parent = fs.lstatSync(path.dirname(socket));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077
  )
    throw Error("Private owned directory required");
  if (fs.existsSync(socket)) throw Error("Socket already exists");
  server.listen(socket, () => fs.chmodSync(socket, 0o600));
  server.once("close", () => {
    try {
      if (fs.lstatSync(socket).isSocket()) fs.unlinkSync(socket);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const env = process.env;
  const gateway = createGateway({
    publicUrl: env.MCP_PUBLIC_URL,
    approvalUrl: env.MCP_APPROVAL_URL,
    redirectUris: JSON.parse(env.MCP_REDIRECT_URIS || "[]"),
    upstreamSocket: env.MCP_UPSTREAM_SOCKET,
    accessIssuer: env.ACCESS_ISSUER,
    accessAudience: env.ACCESS_AUDIENCE,
    ownerEmail: env.ACCESS_OWNER_EMAIL,
  });
  listenPrivate(gateway.publicServer, env.MCP_AUTH_SOCKET);
  listenPrivate(gateway.approvalServer, env.MCP_APPROVAL_SOCKET);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      gateway.publicServer.close();
      gateway.approvalServer.close();
    });
}
