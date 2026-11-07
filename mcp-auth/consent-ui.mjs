import { DEFAULT_GRANT_SECONDS } from "./grant-policy.mjs";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const localUrl = (value) => {
  const text = String(value || "");
  return /^\/(?!\/)/.test(text) && !/[\x00-\x20\\]/.test(text) ? text : "#";
};
export const styleCspHeaders = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const css = `
:root {
  color-scheme: dark;
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    sans-serif;
  color: #e7edf5;
  background: #0b111b;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  min-height: 100dvh;
  padding: 36px 20px;
  background: radial-gradient(ellipse at 50% 0, #152739 0, transparent 65%),
    #0b111b;
}
a {
  color: #70dfcc;
  text-underline-offset: 4px;
}
button,
select {
  font: inherit;
}
button:focus-visible,
a:focus-visible,
select:focus-visible,
summary:focus-visible {
  outline: 3px solid #7ae6d2;
  outline-offset: 4px;
}
.shell {
  max-width: 560px;
  margin: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
  font-size: 14px;
  font-weight: 650;
  color: #c5d4e3;
}
.mark {
  display: grid;
  place-items: center;
  width: 33px;
  height: 33px;
  border: 1px solid #305665;
  border-radius: 9px;
  background: #132c35;
  color: #86e6d5;
  font:
    700 18px ui-monospace,
    monospace;
}
.card {
  background: #111c2a;
  border: 1px solid #2a3b4d;
  border-radius: 20px;
  padding: 32px;
  box-shadow: 0 20px 70px #0005;
}
`;
const extraCss = `
.eyebrow {
  color: #77d9c8;
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin: 0 0 12px;
}
h1 {
  font-size: 29px;
  line-height: 1.2;
  letter-spacing: -0.04em;
  margin: 0 0 12px;
  font-weight: 680;
}
h2 {
  font-size: 16px;
  margin: 0 0 8px;
  line-height: 1.5;
}
.intro {
  color: #a8bacb;
  font-size: 15px;
  line-height: 1.65;
  margin: 0 0 24px;
}
.client {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 16px 0;
  border-block: 1px solid #29394a;
  margin-bottom: 22px;
  min-width: 0;
}
.client-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  background: #203342;
  color: #b9f5e8;
  flex: none;
  font-size: 18px;
}
.client-name {
  font-size: 16px;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.caption {
  font-size: 12px;
  color: #91a7ba;
  line-height: 1.6;
}
.permission-list {
  padding: 0;
  list-style: none;
  margin: 0 0 24px;
  display: grid;
  gap: 16px;
}
.permission-list li {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 10px;
}
.check {
  color: #7adcc8;
}
.permission-list strong {
  font-size: 14px;
  font-weight: 600;
  display: block;
}
.permission-list p {
  margin: 3px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: #94a9bd;
}
.field {
  display: grid;
  gap: 8px;
}
label {
  font-size: 13px;
  font-weight: 650;
}
select {
  width: 100%;
  min-height: 48px;
  border: 1px solid #40566d;
  border-radius: 10px;
  padding: 11px 14px;
  background: #0c1622;
  color: #e7edf5;
  font-size: 15px;
}
.hint {
  margin: 2px 0 0;
  font-size: 12px;
  color: #96aec1;
  line-height: 1.65;
}
.actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}
button,
.button {
  min-height: 46px;
  padding: 12px 18px;
  border-radius: 10px;
  border: 1px solid #3a5065;
  cursor: pointer;
  font-size: 14px;
  font-weight: 650;
  background: #172637;
  color: #d4e0ec;
  text-align: center;
  text-decoration: none;
}
.primary {
  background: #81dfcc;
  border-color: #81dfcc;
  color: #092421;
  flex: 1;
}
.primary:hover {
  background: #a0eddf;
}
.secondary:hover {
  background: #23374a;
}
.footnote {
  margin: 18px 0 0;
  color: #92a8bc;
  font-size: 12px;
  line-height: 1.65;
}
.details {
  margin-top: 22px;
  border-top: 1px solid #29394a;
  padding-top: 12px;
}
summary {
  font-size: 12px;
  color: #91a9bd;
  cursor: pointer;
  min-height: 44px;
  align-content: center;
}
.callback {
  font:
    12px/1.7 ui-monospace,
    monospace;
  overflow-wrap: anywhere;
  background: #0b1521;
  padding: 12px;
  border-radius: 8px;
  color: #a5b9cb;
  margin: 0;
}
.footer {
  padding: 20px 0;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: #7f97ac;
  align-items: center;
}
.footer a {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
}
.connection {
  padding: 20px 0;
  border-top: 1px solid #29394a;
}
.connection-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.connection-head h2 {
  overflow-wrap: anywhere;
  margin: 0;
}
.badge {
  font-size: 11px;
  border: 1px solid #2b645e;
  border-radius: 20px;
  padding: 4px 9px;
  color: #93e9d7;
  flex: none;
}
.badge.expired {
  border-color: #596171;
  color: #b6c0ce;
}
dl {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 7px 10px;
  font-size: 12px;
  line-height: 1.6;
  margin: 14px 0;
}
dt {
  color: #8ea5b9;
}
dd {
  margin: 0;
  color: #c0cede;
  overflow-wrap: anywhere;
}
.revoke {
  min-height: 44px;
  color: #e8b9b9;
  border-color: #66505a;
  background: transparent;
}
.notice {
  padding: 12px 14px;
  border: 1px solid #315e5b;
  background: #15312f;
  border-radius: 10px;
  color: #b5e8dc;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 20px;
}
.empty {
  padding: 20px 0 8px;
  color: #a3b6c9;
  font-size: 14px;
  line-height: 1.7;
}
.empty-icon {
  font-size: 25px;
  margin-bottom: 12px;
  color: #8bdaca;
}
@media (max-width: 480px) {
  body {
    padding: 22px 16px;
  }
  .brand {
    margin-bottom: 20px;
  }
  .card {
    padding: 24px 20px;
    border-radius: 16px;
  }
  h1 {
    font-size: 26px;
  }
  .intro {
    font-size: 14px;
  }
  .footer {
    align-items: flex-start;
    flex-direction: column;
    gap: 0;
  }
  .actions {
    gap: 10px;
  }
  .connection-head {
    align-items: flex-start;
  }
  dl {
    grid-template-columns: 80px minmax(0, 1fr);
  }
}
`;
function page(title, body, footer = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>${escape(
    title,
  )} · Web Terminal</title><style>${css}${extraCss}</style></head><body><main class="shell"><div class="brand"><span class="mark" aria-hidden="true">&gt;_</span>Web Terminal</div><section class="card">${body}</section><footer class="footer"><span>Your terminal. Your control.</span>${footer}</footer></main></body></html>`;
}
export function renderConsent({
  clientName,
  redirectUri,
  requestId,
  csrf,
  durations,
  defaultDuration = String(DEFAULT_GRANT_SECONDS),
  manageUrl = "/consent?view=connections",
}) {
  const options = durations
    .map(
      ({ value, label }) =>
        `<option value="${escape(value)}"${
          String(value) === String(defaultDuration) ? " selected" : ""
        }>${escape(label)}</option>`,
    )
    .join("");
  const identity = `<p class="eyebrow">Connection request</p><h1>Share your terminal</h1><p class="intro">Allow this app to work alongside you in the same terminal. You can watch its input as it happens.</p><div class="client"><span class="client-icon" aria-hidden="true">↗</span><div><div class="client-name">${escape(
    clientName,
  )}</div><div class="caption">Wants access to your Web Terminal</div></div></div>`;
  const permissions = `<ul class="permission-list"><li><span class="check" aria-hidden="true">✓</span><div><strong>Read your terminal screen</strong><p>See the windows, panes and output you share.</p></div></li><li><span class="check" aria-hidden="true">✓</span><div><strong>Type and run commands</strong><p>Enter text, press keys and submit commands in your visible terminal.</p></div></li><li><span class="check" aria-hidden="true">✓</span><div><strong>Work in shared tabs</strong><p>Switch panes and create tabs alongside your existing work.</p></div></li></ul>`;
  const maximum = durations.at(-1)?.label || "the selected duration";
  const form = `<form method="post"><input type="hidden" name="request" value="${escape(
    requestId,
  )}"><input type="hidden" name="csrf" value="${escape(
    csrf,
  )}"><div class="field"><label for="duration">Allow access for</label><select id="duration" name="duration" aria-describedby="duration-hint">${options}</select><p id="duration-hint" class="hint">Starts when you allow access. Maximum: ${escape(maximum)}.</p></div><div class="actions"><button class="primary" name="decision" value="allow">Allow access</button><button class="secondary" name="decision" value="deny">Deny</button></div></form><p class="footnote">Access ends automatically after the selected duration. You can revoke it anytime in connected apps.</p><details class="details"><summary>Connection details</summary><p class="caption">After authorization, return to:</p><p class="callback">${escape(
    redirectUri,
  )}</p></details>`;
  return page(
    "Allow terminal access",
    identity + permissions + form,
    `<a href="${escape(localUrl(manageUrl))}">Manage connected apps →</a>`,
  );
}
function date(value) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }) + " UTC"
    : "Unknown";
}
export function renderConnections({
  connections,
  csrf,
  actionUrl = "/consent?view=connections",
  notice,
}) {
  const rows = connections
    .map((c) => {
      const expired = Number(c.expires) <= Date.now();
      return `<article class="connection"><div class="connection-head"><h2>${escape(
        c.clientName,
      )}</h2><span class="badge${expired ? " expired" : ""}">${
        expired
          ? "Expired"
          : c.status === "pending"
          ? "Awaiting app connection"
          : "Connected"
      }</span></div><dl><dt>Connected</dt><dd>${escape(
        date(c.grantedAt),
      )}</dd><dt>Access ends</dt><dd>${escape(date(c.expires))}</dd></dl>${
        expired
          ? ""
          : `<form method="post" action="${escape(
              localUrl(actionUrl),
            )}"><input type="hidden" name="csrf" value="${escape(
              csrf,
            )}"><input type="hidden" name="action" value="revoke"><input type="hidden" name="grantId" value="${escape(
              c.grantId,
            )}"><button class="revoke" type="submit">Revoke access</button></form>`
      }</article>`;
    })
    .join("");
  return page(
    "Connected apps",
    `<p class="eyebrow">Access settings</p><h1>Connected apps</h1><p class="intro">Manage the apps that can read and control your shared terminal.</p>${
      notice ? `<p class="notice" role="status">${escape(notice)}</p>` : ""
    }${
      rows ||
      '<div class="empty"><div class="empty-icon" aria-hidden="true">◇</div><h2>No connected apps</h2><p>When you allow an app to connect, it will appear here. You can review its expiry and revoke access anytime.</p></div>'
    }<p class="footnote">Revoking access prevents further MCP requests from this connection. Commands already started in your terminal may continue running.</p><div class="actions"><a class="button secondary" href="/">Open Web Terminal</a></div>`,
  );
}
export function renderError({
  title = "This request has expired",
  message = "Return to your app and connect again to start a new request.",
  retryUrl = "/",
  retryLabel = "Open Web Terminal",
}) {
  return page(
    title,
    `<p class="eyebrow">Connection unavailable</p><h1>${escape(
      title,
    )}</h1><p class="intro">${escape(
      message,
    )}</p><p class="footnote">Your existing terminal sessions remain available.</p>${
      retryUrl
        ? `<div class="actions"><a class="button primary" href="${escape(
            localUrl(retryUrl),
          )}">${escape(retryLabel)}</a></div>`
        : ""
    }`,
  );
}
