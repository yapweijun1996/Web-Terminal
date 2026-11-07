import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Opt-in: node linux/test/split-browser.e2e.mjs. No live sockets or user sessions.
// Screenshots use CDP bytes written by Node, avoiding snap Chromium's /tmp limits.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiDirectory = process.env.TERMINAL_UI_DIR || path.join(root, 'linux/ui');
const outputDirectory = process.env.SPLIT_BROWSER_OUTPUT || path.resolve(root, '../out4');
const chromeBin = process.env.CHROME_BIN || [
  '/snap/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
].find(candidate => fs.existsSync(candidate));
assert.ok(chromeBin, 'Chromium is required for the opt-in browser fixture');
assert.equal(typeof WebSocket, 'function', 'Node with built-in WebSocket is required');
let runtimeParent = `/run/user/${process.getuid()}`;
try { fs.accessSync(runtimeParent, fs.constants.W_OK); } catch { runtimeParent = os.tmpdir(); }
const directory = fs.mkdtempSync(path.join(runtimeParent, 'sbfx-'));
fs.chmodSync(directory, 0o700);
const tmuxSocket = `sbfx-${process.pid}-${path.basename(directory)}`;
const socket = path.join(directory, 'ui.sock');
const env = {
  USER: process.env.USER || 'fixture',
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: directory,
  XDG_CONFIG_HOME: path.join(directory, 'config'),
  XDG_DATA_HOME: path.join(directory, 'data'),
  LANG: 'C.UTF-8', TERM: 'xterm-256color', SHELL: '/bin/sh', PS1: '$ ',
  TERMINAL_RUNTIME: directory,
  TERMINAL_TMUX_SOCKET: tmuxSocket,
  TERMINAL_UPLOAD_DIR: path.join(directory, 'uploads'),
  TERMINAL_TEST_HTTP: '1',
};
const tmuxArgs = ['-f', '/dev/null', '-L', tmuxSocket];
function tmux(...args) {
  try {
    return execFileSync('tmux', [...tmuxArgs, ...args], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
  } catch { throw new Error('Isolated tmux command failed'); }
}
let ui, chrome, proxy, ws, browserDirectory;
let messageId = 0, stage = 'setup', javascriptErrors = 0;
const pending = new Map();
const connections = new Set();
const results = [];

async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(label);
}
async function cdp(method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed');
  return result.result.value;
}
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled || !element.getClientRects().length) return null;
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
    if (!element.contains(document.elementFromPoint(x, y))) return null;
    return { x, y };
  })()`);
  assert.ok(point, 'UI control must be visible, enabled and unobscured');
  await clickPoint(point);
}
async function clickPoint({ x, y }) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}
async function keyboardEcho(marker) {
  // No term.write(), tmux send-keys or programmatic focus: exercise real input routing.
  for (const key of `echo ${marker}`) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: key });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key });
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
function panes() {
  return tmux('list-panes', '-t', '=shared:', '-F', '#{pane_id}|#{pane_active}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}')
    .split('\n').map(line => {
      const [id, active, left, top, width, height] = line.split('|');
      return { id, active: active === '1', left: Number(left), top: Number(top), width: Number(width), height: Number(height) };
    });
}
function markerIsExclusive(marker, paneId) {
  return panes().every(pane => {
    const found = tmux('capture-pane', '-p', '-t', pane.id).includes(marker);
    return found === (pane.id === paneId);
  });
}
async function terminalState(markers, geometry) {
  return evaluate(`(() => {
    const frame = document.querySelector('iframe.active');
    const term = frame?.contentWindow?.term;
    if (!term?.buffer?.active) return null;
    const buffer = term.buffer.active;
    const lines = Array.from({ length: term.rows }, (_, y) => buffer.getLine(buffer.viewportY + y)?.translateToString(false) || '');
    const cell = (x, y) => buffer.getLine(buffer.viewportY + y)?.getCell(x)?.getChars() || '';
    const geometry = ${JSON.stringify(geometry)};
    let vertical = 0, horizontal = 0;
    for (const pane of geometry) {
      if (pane.left + pane.width < term.cols) {
        for (let y = pane.top; y < pane.top + pane.height; y++) {
          if (/[│┃║|]/u.test(cell(pane.left + pane.width, y))) vertical++;
        }
      }
      if (pane.top + pane.height < term.rows) {
        for (let x = pane.left; x < pane.left + pane.width; x++) {
          if (/[─━═-]/u.test(cell(x, pane.top + pane.height))) horizontal++;
        }
      }
    }
    const rect = frame.contentDocument.querySelector('.xterm-screen')?.getBoundingClientRect();
    return { cols: term.cols, rows: term.rows, vertical, horizontal,
      markersVisible: ${JSON.stringify(markers)}.every(marker => lines.some(line => line.includes(marker))),
      visible: !!rect && rect.width > 0 && rect.height > 0,
      unchanged: frame === window.__splitFrame && frame.contentDocument === window.__splitDocument && term === window.__splitTerm && window.__splitLoads === 0,
      focused: document.activeElement === frame && frame.contentDocument.activeElement === term.textarea };
  })()`);
}
async function request(origin, pathname, options = {}) {
  return fetch(`${origin}${pathname}`, { ...options, signal: AbortSignal.timeout(5000) });
}
async function closeSession(origin) {
  const listing = await request(origin, '/api/sessions');
  assert.equal(listing.status, 200, 'Session listing must be available');
  const { token } = await listing.json();
  const identityResponse = await request(origin, '/api/sessions/shared/identity');
  assert.equal(identityResponse.status, 200, 'Close must obtain current session identity');
  const identity = await identityResponse.json();
  const response = await request(origin, '/api/sessions/shared/close', {
    method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'x-terminal-request': token,
      'x-terminal-session-id': identity.sessionId, 'x-terminal-server-pid': identity.serverPid,
    },
  });
  assert.equal(response.status, 200, 'Protected close must succeed after splitting');
  assert.equal((await response.json()).ok, true, 'Protected close must acknowledge success');
  const remaining = await (await request(origin, '/api/sessions')).json();
  assert.equal(remaining.sessions.includes('shared'), false, 'Closed session must disappear from the API');
  const exists = spawnSync('tmux', [...tmuxArgs, 'has-session', '-t', '=shared'], { env, stdio: 'ignore', timeout: 5000 });
  assert.equal(exists.status, 1, 'Closed session must no longer exist in private tmux');
}
async function stop(child) {
  if (!child?.pid) return;
  const exited = child.exitCode !== null || child.signalCode !== null;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  if (!exited) {
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  }
  // Process-group cleanup also covers ttyd and Chromium subprocesses.
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}
let cleanupPromise, releaseHold;
function cleanup() {
  cleanupPromise ||= (async () => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    ws?.close();
    await stop(chrome);
    for (const connection of connections) connection.destroy();
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    await stop(ui);
    spawnSync('tmux', [...tmuxArgs, 'kill-server'], { env, stdio: 'ignore', timeout: 5000 });
    if (browserDirectory) fs.rmSync(browserDirectory, { recursive: true, force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  })();
  return cleanupPromise;
}
const interrupt = () => {
  if (releaseHold) { releaseHold(); return; }
  void cleanup().finally(() => process.exit(130));
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

try {
  fs.mkdirSync(outputDirectory, { recursive: true });
  // Hidden anchor keeps private tmux defaults alive between the two fresh sessions.
  tmux('new-session', '-d', '-s', 'fixture-anchor', '-c', directory, '/bin/sh');
  tmux('set-option', '-g', 'default-shell', '/bin/sh');
  tmux('set-option', '-g', 'default-command', '/bin/sh');
  tmux('set-option', '-g', 'status', 'off');
  ui = spawn(process.execPath, [path.join(uiDirectory, 'server.js')], { env, detached: true, stdio: 'ignore' });
  ui.on('error', () => {});
  await waitFor(() => fs.existsSync(socket), 'Fixture UI socket did not start');
  proxy = http.createServer((req, res) => {
    const upstream = http.request({ socketPath: socket, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('connection', client => {
    connections.add(client);
    client.on('close', () => connections.delete(client));
  });
  proxy.on('upgrade', (req, client, head) => {
    const upstream = net.connect(socket, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    connections.add(upstream);
    upstream.on('close', () => connections.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  // Snap can access its common directory, unlike a private host /tmp profile.
  const profileParent = path.join(os.homedir(), 'snap/chromium/common');
  fs.mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  browserDirectory = fs.mkdtempSync(path.join(profileParent, 'sbfx-'));
  chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${browserDirectory}`, 'about:blank',
  ], { env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1' }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let debugPort;
  let browserLog = '';
  chrome.on('error', () => {});
  chrome.stderr.on('data', data => {
    browserLog = (browserLog + data.toString()).slice(-8192);
    debugPort ||= /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(browserLog)?.[1];
  });
  await waitFor(() => !!debugPort, 'Isolated Chromium did not start');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find(candidate => candidate.type === 'page');
  assert.ok(target, 'Chromium page target must exist');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP connection failed')); });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown' || (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')) javascriptErrors++;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`CDP command failed: ${entry.method}`));
    else entry.resolve(message.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  for (const [index, viewport] of [{ width: 1280, height: 800 }, { width: 390, height: 844 }].entries()) {
    stage = `${viewport.width}x${viewport.height}: connect one pane`;
    tmux('new-session', '-d', '-s', 'shared', '-c', directory, '/bin/sh');
    assert.equal(panes().length, 1, 'Each viewport must start with exactly one pane');
    // Manual fixture creation is outside the UI's mutation cache invalidation.
    await waitFor(async () => (await (await request(origin, '/api/sessions')).json()).sessions.includes('shared'),
      'Fixture session must be visible before loading the page');
    await cdp('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url: `${origin}/` });
    await waitFor(() => evaluate(`(() => {
      const frame = document.querySelector('iframe.active');
      return !!frame?.contentWindow?.term?.buffer && frame.contentWindow.webTerminalTarget?.session === 'shared'
        && document.querySelector('#status')?.textContent === 'Connected';
    })()`), 'Real ttyd/xterm must connect with session identity');
    await evaluate(`(() => {
      window.__splitFrame = document.querySelector('iframe.active');
      window.__splitDocument = window.__splitFrame.contentDocument;
      window.__splitTerm = window.__splitFrame.contentWindow.term;
      window.__splitLoads = 0;
      window.__splitFrame.addEventListener('load', () => window.__splitLoads++);
    })()`);
    const point = await evaluate(`(() => {
      const frame = document.querySelector('iframe.active');
      const outer = frame.getBoundingClientRect();
      const rect = frame.contentDocument.querySelector('.xterm-screen').getBoundingClientRect();
      return { x: outer.x + rect.x + rect.width / 2, y: outer.y + rect.y + rect.height / 2 };
    })()`);
    await clickPoint(point);
    const markerPrefix = `sp${Math.random().toString(16).slice(2, 6)}${index}`;
    const markers = [`${markerPrefix}1`];
    await keyboardEcho(markers[0]);
    await waitFor(() => markerIsExclusive(markers[0], panes()[0].id), 'Initial keyboard input must reach the fixture shell');
    const screenshots = [];
    for (const [button, count] of [['#split-right', 2], ['#split-down', 3]]) {
      stage = `${viewport.width}x${viewport.height}: ${count} panes`;
      const previous = panes();
      if (!await evaluate(`document.querySelector('#toolbar-menu').open`)) await click('#toolbar-menu > summary');
      await click(button);
      await waitFor(() => panes().length === count, 'UI split must add exactly one pane');
      const geometry = panes();
      const activePane = geometry.find(pane => pane.active);
      assert.ok(activePane && !previous.some(pane => pane.id === activePane.id), 'New split pane must become active');
      await waitFor(async () => (await terminalState(markers, geometry))?.focused, 'Split must refocus real terminal input');
      const marker = `${markerPrefix}${count}`;
      markers.push(marker);
      await keyboardEcho(marker);
      await waitFor(() => markerIsExclusive(marker, activePane.id), 'Keyboard marker must appear only in the new active pane');
      // Recheck older markers, too: input must not have been broadcast or panes replaced.
      assert.ok(markers.every(value => panes().filter(pane => tmux('capture-pane', '-p', '-t', pane.id).includes(value)).length === 1),
        'Each keyboard marker must remain confined to exactly one pane');
      let state;
      await waitFor(async () => {
        state = await terminalState(markers, geometry);
        const clients = tmux('list-clients', '-t', '=shared', '-F', '#{client_width}|#{client_height}').split('\n');
        return state?.visible && state.markersVisible && state.vertical > 0 && (count === 2 || state.horizontal > 0)
          && clients.length === 1 && clients[0] === `${state.cols}|${state.rows}`;
      }, 'Rendered pane borders, keyboard markers and xterm/tmux client dimensions must agree');
      assert.ok(state.unchanged, 'Split must preserve iframe, document and xterm without any iframe load');
      assert.equal(javascriptErrors, 0, 'Browser must have no JavaScript exceptions or console errors');
      const filename = `split-${viewport.width}x${viewport.height}-${count}-panes.png`;
      const screenshot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(outputDirectory, filename), Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      screenshots.push(filename);
      results.push({ viewport, panes: count, cols: state.cols, rows: state.rows,
        verticalBorderCells: state.vertical, horizontalBorderCells: state.horizontal,
        keyboardExclusive: true, iframeUnchanged: true, screenshot: filename });
    }
    stage = `${viewport.width}x${viewport.height}: protected close`;
    await closeSession(origin);
    assert.equal(screenshots.length, 2, 'Both split layouts must have screenshot proof');
    await cdp('Page.navigate', { url: 'about:blank' });
  }
  assert.equal(javascriptErrors, 0, 'Browser must remain free of JavaScript errors');
  console.log(JSON.stringify({ status: 'PASS', viewports: 2, splitChecks: results.length, closedSessions: 2, javascriptErrors, results }));
  if (process.env.SPLIT_BROWSER_HOLD === '1') {
    // Both tested sessions have closed successfully. Open a fresh isolated surface
    // for external CDP inspection, leaving the verified result counts unchanged.
    stage = 'inspection surface';
    tmux('new-session', '-d', '-s', 'shared', '-c', directory, '/bin/sh');
    await waitFor(async () => (await (await request(origin, '/api/sessions')).json()).sessions.includes('shared'),
      'Inspection session must be visible before loading the page');
    await cdp('Page.navigate', { url: `${origin}/` });
    await waitFor(() => evaluate(`document.querySelector('#status')?.textContent === 'Connected'
      && !!document.querySelector('iframe.active')?.contentWindow?.webTerminalTarget`),
    'Inspection terminal must connect');
    for (const [button, count] of [['#split-right', 2], ['#split-down', 3]]) {
      if (!await evaluate(`document.querySelector('#toolbar-menu').open`)) await click('#toolbar-menu > summary');
      await click(button);
      await waitFor(() => panes().length === count, 'Inspection split must be visible');
    }
    await waitFor(async () => {
      const state = await terminalState([], panes());
      return state?.visible && state.vertical > 0 && state.horizontal > 0;
    }, 'Inspection surface must render three real panes');
    console.log(`Browser fixture ready: ${origin} CDP http://127.0.0.1:${debugPort}`);
    await new Promise(resolve => { releaseHold = resolve; });
    releaseHold = null;
  }
} catch (error) {
  // Never dump CDP events, terminal buffers, HTTP headers, URLs or tmux stderr.
  console.error(`FAIL: split browser fixture (${stage})`);
  console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Fixture operation failed');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  await cleanup();
}
