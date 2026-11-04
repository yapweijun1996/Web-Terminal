import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Opt-in integration fixture. All processes, sockets and browser state are isolated.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const uiDirectory = process.env.TERMINAL_UI_DIR || path.join(root, 'linux/ui');
const pi = process.env.PI_BIN || execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome-stable';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webterm-pi-'));
const tmuxSocket = `wt-pi-${process.pid}`;
const socket = path.join(directory, 'ui.sock');
const bin = path.join(directory, 'bin');
const env = {
  HOME: directory,
  USER: process.env.USER || 'fixture',
  LANG: 'C.UTF-8',
  XDG_CONFIG_HOME: path.join(directory, 'config'),
  XDG_DATA_HOME: path.join(directory, 'data'),
  PI_CODING_AGENT_DIR: path.join(directory, 'pi'),
  PI_OFFLINE: '1',
  PATH: `${bin}:${path.dirname(pi)}:/usr/bin:/bin`,
  TERM: 'xterm-256color',
  DISPLAY: ':fixture',
};
fs.mkdirSync(bin);
// Avoid touching the host desktop clipboard while testing Pi's display-present path.
fs.writeFileSync(path.join(bin, 'xclip'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o700 });
const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', tmuxSocket, ...args], { env, encoding: 'utf8' }).trim();
let ui, chrome, proxy, ws;
let messageId = 0;
const pending = new Map();

async function cdp(method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 10000).unref();
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

try {
  tmux('new-session', '-d', '-s', 'shared');
  ui = spawn(process.execPath, [path.join(uiDirectory, 'server.js')], {
    env: { ...env, TERMINAL_RUNTIME: directory, TERMINAL_TMUX_SOCKET: tmuxSocket, TERMINAL_TEST_HTTP: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await sleep(50);
  assert.ok(fs.existsSync(socket), 'fixture UI socket did not start');

  proxy = http.createServer((req, res) => {
    const upstream = http.request({ socketPath: socket, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  proxy.on('upgrade', (req, client, head) => {
    const upstream = net.connect(socket, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const list = await (await fetch(`${origin}/api/sessions`)).json();
  const response = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-terminal-request': list.token },
    body: '{}',
  });
  assert.equal(response.status, 201, 'fixture session creation failed');
  const { name } = await response.json();
  tmux('new-window', '-t', name, pi,
    '--offline', '--no-session', '--no-extensions', '--no-mcp', '--no-skills',
    '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve');

  chrome = spawn(chromeBin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-extensions', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${directory}/chrome`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, NO_PROXY: 'localhost,127.0.0.1' } });
  let browserLog = '';
  chrome.stderr.on('data', data => { browserLog += data.toString(); });
  for (let i = 0; i < 100 && !browserLog.includes('DevTools listening on'); i++) await sleep(100);
  const debugPort = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(browserLog)?.[1];
  assert.ok(debugPort, 'headless Chrome did not start');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Browser.grantPermissions', { origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await cdp('Page.navigate', { url: `${origin}/` });
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (await evaluate(`document.querySelectorAll('#tabs .tab').length === 2`)) break;
  }
  await evaluate(`document.querySelectorAll('#tabs .tab')[1].querySelector('button').click()`);
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if (await evaluate(`!!document.querySelector('iframe.active')?.contentWindow?.term?.buffer`)) break;
  }
  await sleep(2000);
  const state = await evaluate(`(() => {
    const iframe = document.querySelector('iframe.active');
    const terminal = iframe?.contentWindow?.term;
    if (!terminal) return null;
    const lines = Array.from({length: terminal.rows}, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) || '');
    const screen = iframe.contentDocument.querySelector('.xterm-screen').getBoundingClientRect();
    const frame = iframe.getBoundingClientRect();
    return {cols: terminal.cols, rows: terminal.rows, lines,
      rect: {x: screen.x + frame.x, y: screen.y + frame.y, width: screen.width, height: screen.height}};
  })()`);
  assert.ok(state, 'terminal client did not connect');
  const row = state.lines.findIndex(line => line.includes('Pi can explain'));
  assert.ok(row >= 0, 'Pi startup transcript did not appear');
  const cellWidth = state.rect.width / state.cols;
  const cellHeight = state.rect.height / state.rows;
  const x = state.rect.x + cellWidth * 2.5;
  const y = state.rect.y + cellHeight * (row + 0.5);
  await evaluate(`window.copyEvents = []; window.addEventListener('message', event => {
    if (event.data?.type === 'terminal-clipboard') window.copyEvents.push(event.data.text);
  });`);
  const sample = `(() => {
    const terminal = document.querySelector('iframe.active').contentWindow.term;
    return Array.from({length: terminal.rows}, (_, row) => Array.from({length: terminal.cols}, (_, col) => {
      const cell = terminal.buffer.active.getLine(row)?.getCell(col);
      return cell ? [cell.getBgColorMode(), cell.getBgColor(), cell.getFgColorMode(), cell.getFgColor(), cell.isInverse()] : null;
    }));
  })()`;
  const before = await evaluate(sample);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + cellWidth * i, y, button: 'left', buttons: 1 });
    await sleep(25);
  }
  await sleep(300);
  const during = await evaluate(sample);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + cellWidth * 8, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(1200);
  const after = await evaluate(sample);
  const changed = (a, b) => a.flat().filter((cell, i) => JSON.stringify(cell) !== JSON.stringify(b.flat()[i])).length;
  assert.ok(changed(before, during) > 0, 'Pi selection should be visible during drag');
  assert.ok(changed(before, after) > 0, 'Pi selection should remain visible on release');
  assert.equal(await evaluate('window.copyEvents.length'), 1, 'one copy request should reach the browser');
  const selected = await evaluate('window.copyEvents[0]');
  assert.ok(selected.length >= 4 && state.lines[row].includes(selected), 'copied text must match the selected transcript');
  assert.equal(await evaluate('navigator.clipboard.readText().then(text => text === window.copyEvents[0]).catch(() => false)'), true);
  assert.equal(await evaluate('document.querySelector("#status").textContent'), 'Selection copied');
  console.log('PASS: Pi selection and browser clipboard through ttyd and tmux');
} finally {
  if (ws) ws.close();
  await stop(chrome);
  await stop(ui);
  if (proxy) { proxy.closeAllConnections(); proxy.close(); }
  spawnSync('tmux', ['-L', tmuxSocket, 'kill-server'], { env });
  fs.rmSync(directory, { recursive: true, force: true });
}
