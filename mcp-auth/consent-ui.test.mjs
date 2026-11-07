import test from "node:test";
import assert from "node:assert/strict";
import {
  renderConsent,
  renderConnections,
  renderError,
  styleCspHeaders,
} from "./consent-ui.mjs";
import { GRANT_DURATIONS as durations } from "./grant-policy.mjs";
const input = {
  clientName: "ChatGPT",
  redirectUri: "https://chatgpt.com/callback",
  requestId: "request",
  csrf: "csrf",
  durations,
};
test("default30days, explicit maximum and distinct allow/deny actions", () => {
  const html = renderConsent(input);
  assert.deepEqual([...html.matchAll(/<option value="(\d+)"/g)].map((match) => match[1]),
    ["3600", "86400", "604800", "2592000", "31536000"]);
  assert.match(html, /<label for="duration">Allow access for<\/label>/);
  assert.match(
    html,
    /<option value="2592000" selected>1 month \(30 days\)<\/option>/,
  );
  assert.match(html, /<option value="31536000">1 year \(365 days\)<\/option>/);
  assert.match(html, /name="decision" value="allow"/);
  assert.match(html, /name="decision" value="deny"/);
  assert.match(html, /name="request" value="request"/);
  assert.match(html, /name="csrf" value="csrf"/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(styleCspHeaders["Content-Security-Policy"], /script-src 'none'/);
});
test("untrusted values escaped and navigation cannot inject javascript", () => {
  const hostile = '"><script>alert(1)</script>&';
  const html = renderConsent({
    ...input,
    clientName: hostile,
    redirectUri: hostile,
    requestId: hostile,
    csrf: hostile,
    manageUrl: "javascript:alert(1)",
  });
  assert.doesNotMatch(html, /<script|href="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="#"/);
  assert.doesNotMatch(
    renderError({
      title: hostile,
      message: hostile,
      retryUrl: "//evil.example",
    }),
    /<script|href="\/\/evil/,
  );
});
test("active/expired connections, safe revoke CSRF form and empty state", () => {
  const html = renderConnections({
    connections: [
      {
        grantId: "grant",
        clientName: "ChatGPT",
        status: "pending",
        grantedAt: Date.now(),
        expires: Date.now() + 86400000,
      },
      { grantId: "old", clientName: "Claude", grantedAt: 1, expires: 2 },
    ],
    csrf: "csrf",
    actionUrl: "/consent?view=connections",
    notice: "Revoked",
  });
  assert.match(html, /name="grantId" value="grant"/);
  assert.doesNotMatch(html, /name="grantId" value="old"/);
  assert.match(html, /name="action" value="revoke"/);
  assert.match(html, /name="csrf" value="csrf"/);
  assert.match(html, /Expired/);
  assert.match(html, /Awaiting app connection/);
  assert.match(
    renderConnections({ connections: [], csrf: "csrf" }),
    /No connected apps/,
  );
});

test("error recovery label matches its safe destination and escapes custom text", () => {
  const html = renderError({
    retryUrl: "/consent?view=connections",
    retryLabel: "Manage connections",
  });
  assert.match(
    html,
    /href="\/consent\?view=connections">Manage connections<\/a>/,
  );
  assert.doesNotMatch(renderError({ retryLabel: "<script>" }), /<script>/);
});
