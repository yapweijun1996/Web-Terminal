# Terminal connector consent interface

The server-rendered consent page identifies the requesting app, explains shared terminal read/input/tab permissions, and offers a labelled duration selector. The default is one month (30 days); the longest option is one year (365 days). The backend owns the authoritative duration allowlist and expiry enforcement. Allow and Deny remain distinct form actions; CSRF and request identifiers remain hidden fields. Callback details are expandable and escaped.

Connected apps show grant and expiry times in UTC. Pending grants show “Awaiting app connection”; active grants show “Connected”; expired grants show “Expired”. Revocation is an explicit form submission protected by the backend's CSRF validation. Empty and expired-request pages have a same-origin return action. The interface uses local inline CSS, system fonts and no scripts or external assets; CSP continues to deny scripts.

## Isolated verification

Run `node --test mcp-auth/consent-ui.test.mjs` for form semantics, 30-day default/365-day option, escaping, navigation rejection and connection states. `node mcp-auth/consent-fixture.mjs` serves deterministic mock pages at loopback port 19784 without creating grants or using production tokens. Routes include `/`, `/?long`, `/connections`, `/connections?pending`, `/connections?empty` and `/expired`.

Real Chrome checks covered widths 390, 768 and 1440 pixels. Document width matched the viewport in each. Select height was 48px; consent buttons 46px; disclosure and revoke targets at least 44px. A native select keyboard End/Enter chose the 365-day maximum and showed a 3px focus outline. The isolated Deny form returned a declined page with a return action. A hostile long app name and callback wrapped without horizontal overflow; disclosure expansion/closure and top/middle/bottom scroll positions were checked. Empty, pending, expired and long-name management states were rendered. The expired page had no console warnings/errors.

Ignored evidence is under `artifacts/consent/`: before.png, after-390.png, after-768.png, after-1440.png, long-expanded-390.png, connections-long390.png, connections-pending390.png, connections-empty390.png, expired390.png and metrics.json. Parent review also captured desktop-parent.png and mobile-parent.png.

This verifies local SSR layout and form presentation. It does not prove native mobile hardware, screen-reader audio, browser zoom behavior, or live ChatGPT/Claude authorization acceptance. Live authenticated owner consent was not exercised by the fixture.
