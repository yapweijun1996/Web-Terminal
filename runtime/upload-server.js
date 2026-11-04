"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  execFile = require("node:child_process").execFile,
  promisify = require("node:util").promisify;
const inspect = promisify(execFile);
const { createUploadTargets } = require('./upload-target');
const socket = process.env.TERMINAL_UPLOAD_SOCKET,
  directory = process.env.TERMINAL_UPLOAD_DIR,
  origin = process.env.TERMINAL_ALLOWED_ORIGIN;
if (
  !socket ||
  !directory ||
  !origin ||
  !path.isAbsolute(socket) ||
  !path.isAbsolute(directory)
)
  throw new Error("Missing configuration");
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const ds = fs.lstatSync(directory);
if (
  !ds.isDirectory() ||
  ds.isSymbolicLink() ||
  ds.uid !== process.getuid() ||
  (ds.mode & 0o077) !== 0
)
  throw new Error("Unsafe upload directory");
try {
  const st = fs.lstatSync(socket);
  if (!st.isSocket() || st.uid !== process.getuid())
    throw new Error("Unsafe socket");
  fs.unlinkSync(socket);
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const max = 10 * 1024 * 1024;
let active = 0;
let controlActive = 0;
const targets = createUploadTargets(process.env.WEB_TERMINAL_TMUX_SERVER, process.env.TMUX_BIN || 'tmux');
function reply(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
function extension(buf) {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255)
    return "jpg";
  if (
    buf.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(buf.subarray(0, 6).toString("ascii"))
  )
    return "gif";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  )
    return "webp";
  return null;
}
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/__terminal_upload")
    return reply(res, 404, { error: "Not found" });
  if (req.headers.origin !== origin)
    return reply(res, 403, { error: "Origin not allowed" });
  const action = req.headers['x-terminal-action'];
  if (action === 'capture' || action === 'insert' || action === 'result') {
    if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0)
      return reply(res, 400, { error: 'Unexpected request body' });
    if (controlActive >= 4) return reply(res, 429, { error: 'Too many target requests' });
    controlActive++;
    let controlFinished = false, controlProcessing = false;
    const finishControl = () => {
      if (!controlFinished) { controlFinished = true; controlActive--; }
    };
    const abortControl = () => { if (!controlProcessing) finishControl(); };
    req.resume();
    req.on('end', async () => {
      if (controlFinished) return;
      controlProcessing = true;
      try {
        const result = action === 'capture'
          ? await targets.capture(req.headers['x-terminal-view'], req.headers['x-terminal-session'], req.headers['x-terminal-pane'])
          : action === 'result'
            ? targets.result(req.headers['x-terminal-target'])
            : await targets.insert(req.headers['x-terminal-target']);
        reply(res, 200, result || { inserted: true });
      } catch {
        reply(res, 409, { error: 'Target unavailable' });
      } finally {
        finishControl();
      }
    });
    // A request aborted before its body ends must release its reserved slot.
    req.on('aborted', abortControl);
    req.on('error', abortControl);
    return;
  }
  if (action) return reply(res, 400, { error: 'Unknown action' });
  if (
    (req.headers["content-type"] || "").split(";")[0] !==
    "application/octet-stream"
  )
    return reply(res, 415, { error: "Unsupported content type" });
  const len = req.headers["content-length"];
  if (len && (!/^\d+$/.test(len) || Number(len) > max))
    return reply(res, 413, { error: "Image exceeds 10 MB" });
  if (active >= 4) return reply(res, 429, { error: "Too many uploads" });
  active++;
  let done = false,
    processing = false,
    size = 0,
    parts = [];
  function finish() {
    if (!done) {
      done = true;
      active--;
    }
  }
  // Once filesystem or image inspection work starts, that work owns the slot
  // until its finally block runs, even if the client disconnects meanwhile.
  const finishBeforeProcessing = () => {
    if (!processing) finish();
  };
  req.on("error", finishBeforeProcessing);
  req.on("aborted", finishBeforeProcessing);
  req.on("data", (chunk) => {
    if (done) return;
    size += chunk.length;
    if (size > max) {
      parts = [];
      reply(res, 413, { error: "Image exceeds 10 MB" });
      req.resume();
      return;
    }
    parts.push(chunk);
  });
  req.on("end", async () => {
    if (done) return;
    if (size > max) {
      finish();
      return;
    }
    const data = Buffer.concat(parts);
    const ext = extension(data);
    if (!ext) {
      reply(res, 415, {
        error: "Only PNG, JPEG, GIF, and WebP images are supported",
      });
      finish();
      return;
    }
    const name = crypto.randomUUID() + "." + ext;
    const dest = path.join(directory, name);
    let handle;
    processing = true;
    try {
      handle = await fs.promises.open(
        dest,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(data);
      await handle.close();
      handle = null;
      const result = await inspect(
        "/usr/bin/sips",
        ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", dest],
        { timeout: 8000, maxBuffer: 8192 },
      );
      const fmt = (result.stdout.match(/^\s*format:\s*(\w+)\s*$/m) || [])[1];
      const width = Number(
        (result.stdout.match(/^\s*pixelWidth:\s*(\d+)\s*$/m) || [])[1],
      );
      const height = Number(
        (result.stdout.match(/^\s*pixelHeight:\s*(\d+)\s*$/m) || [])[1],
      );
      if (
        fmt !== (ext === "jpg" ? "jpeg" : ext) ||
        !width ||
        !height ||
        width * height > 40000000
      )
        throw Error("Invalid or oversized image dimensions");
      const targetBound = targets.bind(req.headers['x-terminal-target'], dest);
      reply(res, 201, { path: dest, targetBound });
    } catch (e) {
      if (handle) await handle.close().catch(() => {});
      await fs.promises.unlink(dest).catch(() => {});
      reply(res, 415, {
        error: "Invalid image or dimensions exceed 40 megapixels",
      });
    } finally {
      finish();
    }
  });
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxHeadersCount = 64;
server.listen(socket, () => fs.chmodSync(socket, 0o600));
