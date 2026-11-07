import http from "node:http";
import {
  renderConsent,
  renderConnections,
  renderError,
  styleCspHeaders,
} from "./consent-ui.mjs";
import { GRANT_DURATIONS as durations } from "./grant-policy.mjs";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const long = url.searchParams.has("long");
  const clientName = long
    ? "ChatGPT <untrusted-app> " + "A-long-application-name-".repeat(10)
    : "ChatGPT";
  let html;
  if (req.method === "POST")
    html = renderError({
      title: "Request declined",
      message:
        "The app has not been granted access. Return to the app when you are ready to connect.",
    });
  else if (url.pathname === "/expired")
    html = renderError({
      title: "This request has expired",
      message: "Return to your app and connect again to start a new request.",
    });
  else if (url.pathname === "/connections")
    html = renderConnections({
      connections: url.searchParams.has("empty")
        ? []
        : [
            {
              grantId: "fixture",
              status: url.searchParams.has("pending") ? "pending" : "active",
              clientName,
              grantedAt: Date.UTC(2026, 10, 5, 10),
              expires: Date.UTC(2026, 11, 5, 10),
            },
            {
              grantId: "expired",
              clientName: "Claude",
              grantedAt: Date.UTC(2026, 9, 1),
              expires: Date.UTC(2026, 9, 31),
            },
          ],
      csrf: "fixture-only",
      actionUrl: "/connections",
      notice: url.searchParams.has("notice")
        ? "Access revoked. The app can no longer send terminal requests."
        : undefined,
    });
  else
    html = renderConsent({
      clientName,
      requestId: "fixture-only",
      csrf: "fixture-only",
      durations,
      manageUrl: "/connections",
      redirectUri:
        "https://chatgpt.com/connector_platform_oauth_redirect" +
        (long ? "?state=" + "long-callback-value".repeat(35) : ""),
    });
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    ...styleCspHeaders,
  });
  res.end(html);
});
server.listen(19784, "127.0.0.1", () =>
  console.log("Consent fixture http://127.0.0.1:19784"),
);
