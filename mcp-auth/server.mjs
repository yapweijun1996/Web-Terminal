import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { GrantStore } from "./grant-store.mjs";
import {
  renderConsent,
  renderConnections,
  renderError,
} from "./consent-ui.mjs";
import {
  GRANT_DURATIONS,
  DEFAULT_GRANT_SECONDS,
  AUTH_CODE_TTL_MS,
} from "./grant-policy.mjs";
export const DURATIONS = GRANT_DURATIONS;
export const DEFAULT_DURATION = String(DEFAULT_GRANT_SECONDS);
const random = () => crypto.randomBytes(32).toString("base64url");
const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("base64url");
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
// This deadline covers the entire body, rather than resetting on each chunk.
// Reject before opening the upstream connection; never log the received bytes.
class McpBodyError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
function readMcpBody(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAbort);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        // A response with Connection: close terminates incomplete bodies. An
        // aborted IncomingMessage may emit an error after its aborted event.
        req.pause();
        req.once("error", () => {});
        reject(error);
      } else resolve(Buffer.concat(chunks, length));
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > 1048576)
        return finish(new McpBodyError(413, "request_too_large"));
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAbort = () => finish(new McpBodyError(400, "invalid_request"));
    const onError = () => finish(new McpBodyError(400, "invalid_request"));
    const onClose = () => { if (!req.complete) onAbort(); };
    const timer = setTimeout(() => finish(new McpBodyError(408, "request_timeout")), timeoutMs);
    timer.unref();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAbort);
    req.once("error", onError);
    req.once("close", onClose);
    if (req.aborted || req.destroyed) onAbort();
  });
}
function validHttps(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash)
    throw Error("HTTPS URL required");
  return u;
}
// CSP ignores query strings; application redirect checks still match the full registered URL.
// Encode path punctuation that could otherwise become a CSP directive delimiter.
export function callbackFormSource(redirect) {
  const url = validHttps(redirect);
  return (
    url.origin +
    url.pathname.replace(
      /[;'"\s]/g,
      (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
    )
  );
}
export function createAccessIdentityVerifier(config, keys) {
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
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 1024 ||
        typeof payload.email !== "string" || !Number.isSafeInteger(payload.exp * 1000))
      throw Error("Invalid Access identity");
    if (config.ownerEmail && payload.email !== config.ownerEmail) return null;
    return Object.freeze({
      ownerId: hash(accessIssuer + "\0" + payload.sub),
      expires: payload.exp * 1000,
    });
  };
}
export function createAccessVerifier(config, keys) {
  const identity = createAccessIdentityVerifier(config, keys);
  const verify = async req => Boolean(await identity(req));
  verify.identity = identity;
  return verify;
}
export function createGateway(config, verifyOwner) {
  const resource = validHttps(config.publicUrl).href,
    issuer = new URL(resource).origin,
    approval = validHttps(config.approvalUrl),
    publicHost = new URL(resource).host;
  const mcpBodyTimeoutMs = config.mcpBodyTimeoutMs ?? 5000;
  if (!Number.isInteger(mcpBodyTimeoutMs) || mcpBodyTimeoutMs < 1 || mcpBodyTimeoutMs > 30000)
    throw Error("MCP body timeout must be an integer from 1 to 30000 milliseconds");
  if (config.collaborationSocket !== undefined &&
      (typeof config.collaborationSocket !== "string" || !path.isAbsolute(config.collaborationSocket)))
    throw Error("Absolute collaboration socket required");
  // Optional deployments do not require the coordinator or its modules.
  const collaboration = config.collaborationSocket
    ? createRequire(import.meta.url)("../runtime/gateway/collaboration-contract.cjs") : null;
  const revocations = new Map();
  const rememberRevocation = (key, state) => {
    if (!revocations.has(key) && revocations.size >= 1000) {
      const completed = [...revocations].find(([, value]) => value.confirmed);
      if (completed) revocations.delete(completed[0]);
    }
    if (revocations.has(key) || revocations.size < 1000) revocations.set(key, state);
  };
  const revokeAdmission = async grantId => {
    if (!collaboration) return true;
    if (!grantId) return false;
    try {
      const result = await collaboration.privateCall(config.collaborationSocket, "/v1/revoke", { grantId });
      return result?.revoked === true && !result.error;
    } catch { return false; }
  };
  const redirects = new Set(
    config.redirectUris.map((value) => validHttps(value).href),
  );
  if (!redirects.size) throw Error("Redirect allowlist required");
  if (config.maxGrantSeconds !== undefined &&
      !DURATIONS.some((option) => option.value === String(config.maxGrantSeconds)))
    throw Error("Grant maximum must be an allowed duration");
  const durations = DURATIONS.filter((option) =>
    config.maxGrantSeconds === undefined || Number(option.value) <= Number(config.maxGrantSeconds));
  const defaultDuration = durations.some((option) => option.value === DEFAULT_DURATION)
    ? DEFAULT_DURATION : durations.at(-1).value;
  if (!verifyOwner) verifyOwner = createAccessVerifier(config);
  const store = new GrantStore({
    stateDir: config.stateDir,
    keyFile: config.keyFile,
    resource,
    issuer,
  });
  const pending = new Map(),
    codes = new Map(),
    management = new Map(),
    handled = new Map();
  const prune = () => {
    store.prune();
    for (const map of [pending, codes, management, handled])
      for (const [k, v] of map) if (v.expires <= Date.now()) map.delete(k);
  };
  let budget = 0,
    reset = Date.now() + 60000;
  const metadata = {
    issuer,
    authorization_response_iss_parameter_supported: true,
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
  const unauthorizedMcp = res => send(res, 401, { error: "invalid_token" }, {
    "WWW-Authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`,
  });
  // Never log queries, bodies, headers, identities or credentials.
  const observe = (req, res, surface) => {
    if (!config.onRequest) return;
    const pathname = new URL(req.url, issuer).pathname;
    const route = [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      "/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke",
      "/mcp", approval.pathname,
    ].includes(pathname) ? pathname : "other";
    const method = ["GET", "POST", "DELETE", "OPTIONS", "HEAD"].includes(req.method) ? req.method : "other";
    res.once("finish", () => config.onRequest({ surface, route, method, status: res.statusCode }));
  };
  const publicServer = http.createServer(async (req, res) => {
    try {
      observe(req, res, "public");
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
          input.redirect_uris.some((x) => !redirects.has(x))
        )
          return fail(res);
        if (
          input.token_endpoint_auth_method &&
          input.token_endpoint_auth_method !== "none"
        )
          return fail(res);
        const client_id = random();
        store.addClient(client_id, {
          redirects: input.redirect_uris,
          name: String(input.client_name || "MCP client").slice(0, 80),
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
          client = store.client(q.get("client_id"));
        if (
          [...new Set(q.keys())].some((k) => q.getAll(k).length !== 1) ||
          !client ||
          !client.redirects.includes(q.get("redirect_uri")) ||
          !redirects.has(q.get("redirect_uri")) ||
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
          record = codes.get(
            store.digest("authorization-code", q.get("code") || ""),
          );
        codes.delete(store.digest("authorization-code", q.get("code") || ""));
        if (
          [...new Set(q.keys())].some((k) => q.getAll(k).length !== 1) ||
          q.get("grant_type") !== "authorization_code" ||
          !record ||
          record.clientId !== q.get("client_id") ||
          record.redirect !== q.get("redirect_uri") ||
          q.get("resource") !== resource ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(q.get("code_verifier") || "") ||
          hash(q.get("code_verifier")) !== record.challenge ||
          record.grantExpires <= Date.now()
        )
          return fail(res);
        const access_token = random();
        store.bindToken(record.grantId, access_token);
        return send(res, 200, {
          access_token,
          token_type: "Bearer",
          expires_in: Math.floor((record.grantExpires - Date.now()) / 1000),
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
        const token = q.get("token") || "";
        const statusKey = store.digest("access-token", token);
        const previous = revocations.get(statusKey);
        const revokedId = store.revokeToken(token);
        if (!collaboration) return send(res, 200, {});
        const grantId = revokedId || previous?.grantId;
        // An unknown token remains invalid, but after restart/eviction we cannot
        // claim that its earlier in-flight coordinator work was drained.
        if (!grantId) return send(res, 503, { error: "revocation_status_unavailable" });
        if (previous?.confirmed && !revokedId) return send(res, 200, {});
        rememberRevocation(statusKey, { grantId, confirmed: false });
        if (!(await revokeAdmission(grantId)))
          return send(res, 503, { error: "revocation_pending" });
        rememberRevocation(statusKey, { grantId, confirmed: true });
        return send(res, 200, {});
      }
      if (url.pathname === "/mcp") {
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
          req.headers.authorization || "",
        );
        if (!match || !store.validToken(match[1]))
          return unauthorizedMcp(res);
        if (req.method !== "POST")
          return send(
            res,
            405,
            { error: "method_not_allowed" },
            { Allow: "POST" },
          );
        if (Number(req.headers["content-length"] || 0) > 1048576)
          return send(res, 413, { error: "request_too_large" });
        let data;
        try {
          data = await readMcpBody(req, mcpBodyTimeoutMs);
        } catch (error) {
          if (req.destroyed || res.destroyed) return;
          if (!(error instanceof McpBodyError)) throw error;
          return send(res, error.status, { error: error.code }, { Connection: "close" });
        }
        if (req.aborted || (!req.complete && req.destroyed) || res.destroyed) return;
        // Revocation or expiry may occur while a client withholds body bytes.
        // There is no asynchronous work between this check and upstream setup.
        if (!store.validToken(match[1])) return unauthorizedMcp(res);
        const headers = {
          "content-type": req.headers["content-type"] || "application/json",
          accept: req.headers.accept || "application/json, text/event-stream",
          "content-length": data.length,
        };
        if (req.headers["mcp-protocol-version"])
          headers["mcp-protocol-version"] = req.headers["mcp-protocol-version"];
        if (collaboration) {
          let message;
          try { message = JSON.parse(data); } catch { /* SDK validates malformed JSON. */ }
          const tool = message?.method === "tools/call" ? message.params?.name : null;
          if (tool === "terminal_type" || tool === "terminal_send_key") {
            const grant = store.grantForToken(match[1]);
            if (!grant) return unauthorizedMcp(res);
            let admission;
            try {
              const digest = collaboration.operationDigest(tool, message.params.arguments);
              admission = await collaboration.privateCall(config.collaborationSocket, "/v1/admit", { grant, tool, digest });
            } catch {
              if (!store.validToken(match[1])) return unauthorizedMcp(res);
              return send(res, 503, { error: "input_authority_unavailable" });
            }
            const current = store.grantForToken(match[1]);
            if (!current || current.id !== grant.id || current.expires !== grant.expires) {
              await revokeAdmission(grant.id);
              return unauthorizedMcp(res);
            }
            if (!admission || !/^[A-Za-z0-9_-]{16,200}$/.test(admission.admission || "") ||
                !Number.isSafeInteger(admission.expires) || admission.expires <= Date.now() ||
                admission.expires > grant.expires || admission.expires > Date.now() + 15000)
              return send(res, 503, { error: "input_authority_unavailable" });
            if (req.aborted || res.destroyed) return;
            // Never forward a caller-provided admission or bearer header.
            headers["x-web-terminal-admission"] = admission.admission;
          }
        }
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
        upstream.end(data);
        return;
      }
      return send(res, 404, { error: "not_found" });
    } catch {
      return fail(res);
    }
  });
  const approvalServer = http.createServer(async (req, res) => {
    try {
      observe(req, res, "approval");
      prune();
      if (
        req.headers.host !== approval.host ||
        new URL(req.url, approval).pathname !== approval.pathname
      )
        return fail(res);
      const pageUrl = new URL(req.url, approval);
      if (req.method === "GET" && pageUrl.searchParams.get("view") === "input-identity") {
        // Only the cryptographically verified identity projection is accepted.
        // Boolean-only test/legacy verifiers cannot synthesize an owner role.
        if (typeof verifyOwner.identity !== "function") return fail(res, 401);
        const identity = await verifyOwner.identity(req);
        if (!identity || typeof identity.ownerId !== "string" || !identity.ownerId ||
            !Number.isSafeInteger(identity.expires) || identity.expires <= Date.now())
          return fail(res, 401);
        return send(res, 200, { authorized: true, ownerId: identity.ownerId, expires: identity.expires });
      }
      if (!(await verifyOwner(req))) return fail(res, 401);
      const pageHeaders = {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "same-origin",
      };
      if (req.method === "GET") {
        if (pageUrl.searchParams.get("view") === "connections") {
          if (management.size >= 100)
            management.delete(management.keys().next().value);
          const csrf = random();
          management.set(csrf, { expires: Date.now() + 300000 });
          return send(
            res,
            200,
            renderConnections({
              connections: store.list(),
              csrf,
              actionUrl: approval.pathname + "?view=connections",
              notice:
                pageUrl.searchParams.get("revoked") === "1"
                  ? "Connection revoked."
                  : "",
            }),
            pageHeaders,
          );
        }
        const id = pageUrl.searchParams.get("request"),
          record = pending.get(id);
        if (!record)
          return send(
            res,
            400,
            renderError({
              title: "Connection request expired",
              message:
                "Return to ChatGPT or Claude and connect this terminal again.",
              retryUrl: approval.pathname + "?view=connections",
              retryLabel: "Manage connections",
            }),
            pageHeaders,
          );
        return send(
          res,
          200,
          renderConsent({
            clientName: record.name,
            redirectUri: record.redirect,
            requestId: id,
            csrf: record.csrf,
            durations,
            defaultDuration,
            manageUrl: approval.pathname + "?view=connections",
          }),
          {
            ...pageHeaders,
            "Content-Security-Policy": pageHeaders[
              "Content-Security-Policy"
            ].replace(
              "form-action 'self'",
              "form-action 'self' " + callbackFormSource(record.redirect),
            ),
          },
        );
      }
      const formError = (message) =>
        send(
          res,
          400,
          renderError({
            title: "Unable to confirm this request",
            message,
            retryUrl: approval.pathname + "?view=connections",
            retryLabel: "Manage connections",
          }),
          pageHeaders,
        );
      if (req.method === "POST" && req.headers.origin !== approval.origin)
        return formError(
          "Return to your app and connect again. This form could not be verified.",
        );
      if (
        req.method !== "POST" ||
        !(req.headers["content-type"] || "").startsWith(
          "application/x-www-form-urlencoded",
        )
      )
        return fail(res);
      const q = new URLSearchParams(await body(req));
      if ([...new Set(q.keys())].some((key) => q.getAll(key).length !== 1))
        return fail(res);
      if (pageUrl.searchParams.get("view") === "connections") {
        const csrf = q.get("csrf");
        if (
          !management.has(csrf) ||
          q.get("action") !== "revoke" ||
          !/^[A-Za-z0-9_-]{43}$/.test(q.get("grantId") || "")
        )
          return formError(
            "Refresh connected apps and try again. This request has expired or could not be verified.",
          );
        management.delete(csrf);
        store.revokeGrant(q.get("grantId"));
        if (!(await revokeAdmission(q.get("grantId")))) {
          if (management.size >= 100) management.delete(management.keys().next().value);
          const retryCsrf = random();
          management.set(retryCsrf, { expires: Date.now() + 300000 });
          // These values are server-random or validated opaque IDs. Omitting
          // action keeps native retry on this exact verified management URL.
          const retry = `<form method="post"><input type="hidden" name="csrf" value="${retryCsrf}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="grantId" value="${q.get("grantId")}"><button type="submit">Confirm input cancellation</button></form>`;
          const page = renderError({
            title: "Access revoked; input cancellation pending",
            message: "This app can no longer make authorized requests. Confirmation that earlier terminal input has stopped is unavailable. Retry confirmation below or use the terminal controls to pause AI input and verify its status.",
            retryUrl: approval.pathname + "?view=connections",
            retryLabel: "Manage connections",
          }).replace("</main>", retry + "</main>");
          return send(res, 503, page, pageHeaders);
        }
        return send(res, 303, "", {
          Location: approval.pathname + "?view=connections&revoked=1",
        });
      }
      const completed = handled.get(q.get("request"));
      if (completed && completed.csrf === q.get("csrf"))
        return send(
          res,
          409,
          renderError({
            title: "Connection request already handled",
            message:
              "This request has already been sent back to your app. Return to ChatGPT or Claude. If it did not connect, start a new connection request; allowing again will not resend the previous authorization.",
            retryUrl: approval.pathname + "?view=connections",
            retryLabel: "Manage connections",
          }),
          pageHeaders,
        );
      const record = pending.get(q.get("request"));
      if (!record)
        return send(
          res,
          400,
          renderError({
            title: "Connection request expired",
            message:
              "Return to ChatGPT or Claude and connect this terminal again.",
            retryUrl: approval.pathname + "?view=connections",
            retryLabel: "Manage connections",
          }),
          pageHeaders,
        );
      if (
        record.csrf !== q.get("csrf") ||
        !["allow", "deny"].includes(q.get("decision"))
      )
        return formError(
          "Return to your app and connect again. This form has expired or could not be verified.",
        );
      const duration = q.get("duration") ?? defaultDuration;
      if (!durations.some((option) => option.value === duration))
        return fail(res);
      pending.delete(q.get("request"));
      const location = new URL(record.redirect);
      // RFC 9207 issuer binding enables ChatGPT's stable callback URI.
      location.searchParams.set("iss", issuer);
      if (record.state !== null)
        location.searchParams.set("state", record.state);
      if (q.get("decision") === "allow") {
        const code = random();
        const grantedAt = Date.now(),
          grantExpires = grantedAt + Number(duration) * 1000;
        const grantId = store.createGrant({
          clientId: record.clientId,
          clientName: record.name,
          resource,
          grantedAt,
          expires: grantExpires,
        });
        codes.set(store.digest("authorization-code", code), {
          ...record,
          grantId,
          grantExpires,
          expires: grantedAt + AUTH_CODE_TTL_MS,
        });
        location.searchParams.set("code", code);
      } else location.searchParams.set("error", "access_denied");
      if (handled.size >= 100) handled.delete(handled.keys().next().value);
      handled.set(q.get("request"), {
        csrf: record.csrf,
        expires: Date.now() + 300000,
      });
      return send(res, 302, "", { Location: location.href });
    } catch {
      return fail(res, 401);
    }
  });
  // This verifier is never routed through the public or approval surfaces.
  // A failed lookup is an authority failure, never a cached positive result.
  const grantVerifierServer = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/grant" ||
          req.headers.host !== "localhost" || req.headers.origin)
        return send(res, 404, { error: "not_found" });
      if (Number(req.headers["content-length"] || 0) > 4096)
        return send(res, 413, { error: "request_too_large" });
      let data;
      try { data = await readMcpBody(req, 1000); }
      catch (error) {
        if (req.destroyed || res.destroyed) return;
        if (!(error instanceof McpBodyError)) throw error;
        return send(res, error.status, { error: error.code }, { Connection: "close" });
      }
      if (data.length > 4096) return send(res, 413, { error: "request_too_large" });
      let value;
      try { value = JSON.parse(data); }
      catch { return send(res, 400, { error: "invalid_request" }); }
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(value.grantId || ""))
        return send(res, 400, { error: "invalid_request" });
      return send(res, 200, store.activeGrant(value.grantId));
    } catch { return send(res, 503, { error: "grant_authority_unavailable" }); }
  });
  for (const server of [publicServer, approvalServer]) {
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    server.maxHeadersCount = 64;
  }
  let closed = 0;
  for (const server of [publicServer, approvalServer])
    server.once("close", () => {
      if (++closed === 2) {
        if (grantVerifierServer.listening) grantVerifierServer.close(() => store.close());
        else store.close();
      }
    });
  grantVerifierServer.requestTimeout = 2000;
  grantVerifierServer.headersTimeout = 1000;
  grantVerifierServer.maxHeadersCount = 16;
  return { publicServer, approvalServer, grantVerifierServer };
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
  if (!env.MCP_STATE_DIR || !env.MCP_STATE_KEY_FILE)
    throw Error("Persistent authorization storage configuration required");
  const gateway = createGateway({
    stateDir: env.MCP_STATE_DIR,
    keyFile: env.MCP_STATE_KEY_FILE,
    publicUrl: env.MCP_PUBLIC_URL,
    approvalUrl: env.MCP_APPROVAL_URL,
    redirectUris: JSON.parse(env.MCP_REDIRECT_URIS || "[]"),
    upstreamSocket: env.MCP_UPSTREAM_SOCKET,
    collaborationSocket: env.MCP_COLLABORATION_SOCKET,
    accessIssuer: env.ACCESS_ISSUER,
    accessAudience: env.ACCESS_AUDIENCE,
    ownerEmail: env.ACCESS_OWNER_EMAIL,
    maxGrantSeconds: env.MCP_GRANT_MAX_SECONDS,
    mcpBodyTimeoutMs: env.MCP_REQUEST_BODY_TIMEOUT_MS === undefined
      ? undefined : Number(env.MCP_REQUEST_BODY_TIMEOUT_MS),
    onRequest: env.MCP_AUTH_LOG_REQUESTS === "1"
      ? (event) => console.error(JSON.stringify({ event: "oauth_http", ...event }))
      : undefined,
  });
  listenPrivate(gateway.publicServer, env.MCP_AUTH_SOCKET);
  listenPrivate(gateway.approvalServer, env.MCP_APPROVAL_SOCKET);
  if (env.MCP_GRANT_VERIFY_SOCKET !== undefined)
    listenPrivate(gateway.grantVerifierServer, env.MCP_GRANT_VERIFY_SOCKET);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      gateway.publicServer.close();
      gateway.approvalServer.close();
      gateway.grantVerifierServer.close();
    });
}
