'use strict';
// Opt-in: PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/touch-scroll.e2e.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-touch-'));
const socketName = `wt-touch-${process.pid}`;
const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', socketName, ...args], { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
async function run(platform) {
  if (platform !== 'linux') tmux('source-file', path.join(root, 'runtime/tmux.conf'));
  const runtime = path.join(dir, platform); fs.mkdirSync(runtime, { mode: 0o700 });
  const socket = path.join(runtime, platform === 'linux' ? 'ui.sock' : 'ttyd.sock');
  const child = platform === 'linux'
    ? spawn(process.execPath, [path.join(root, 'linux/ui/server.js')], { env: { ...process.env, TERMINAL_RUNTIME: runtime, TERMINAL_TMUX_SOCKET: socketName, TERMINAL_TEST_HTTP: '1', TERMINAL_UPLOAD_DIR: path.join(runtime, 'uploads') }, stdio: 'ignore' })
    : spawn('ttyd', ['-i', socket, '-W', '-O', '-I', path.join(root, 'client/dist/inline.html'), 'tmux', '-L', socketName, 'attach-session', '-t', 'shared'], { stdio: 'ignore' });
  const proxy = http.createServer((req, res) => {
    const upstream = http.request({ socketPath: socket, method: req.method, path: req.url, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  proxy.on('upgrade', (req, client, head) => {
    const upstream = net.connect(socket, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  let context;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(socket); i++) await sleep(50);
    assert.ok(fs.existsSync(socket), 'fixture origin started');
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    if (process.env.TOUCH_SCROLL_BASELINE === '1') await page.route('**/touch-scroll.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
    if (process.env.TOUCH_SCROLL_LIVE_BRIDGE && platform === 'linux') {
      await page.route('**/touch-scroll.js', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
      await page.route('**/clipboard-bridge.js', route => route.fulfill({ body: fs.readFileSync(process.env.TOUCH_SCROLL_LIVE_BRIDGE), contentType: 'text/javascript' }));
    }
    const cdp = await context.newCDPSession(page);
    // The Linux fixture uses the actual proxy-injected script. The standalone
    // fixture uses the built Mac HTML with the same shared source inlined.
    const url = origin + (platform === 'linux' ? '/terminal/shared' : '/');
    await page.goto(url);
    await page.waitForFunction(() => window.term?.rows > 0 && window.term?.modes?.mouseTrackingMode !== 'none' && !window.term?.options.disableStdin);
    await sleep(600);
    const panePid = tmux('display-message', '-p', '-t', 'shared', '#{pane_pid}');
    const draft = 'UNSUBMITTED_TOUCH_FIXTURE';
    await page.keyboard.type(draft);
    const position = () => Number(tmux('display-message', '-p', '-t', 'shared', '#{scroll_position}'));
    async function swipe(from, to) {
      const rect = await page.locator('.xterm-screen').boundingBox();
      const x = Math.round(rect.x + rect.width / 2);
      const y = fraction => Math.round(rect.y + rect.height * fraction);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y(from), id: 1 }] });
      for (let step = 1; step <= 12; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y(from + (to - from) * step / 12), id: 1 }] });
        await sleep(12);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(250);
    }
    await swipe(.3, .65);
    if (process.env.TOUCH_SCROLL_BASELINE === '1') {
      assert.equal(tmux('display-message', '-p', '-t', 'shared', '#{pane_in_mode}'), '0', 'unpatched touch reproduces missing scrollback');
      console.log('linux baseline: native touch fails to enter tmux scrollback (bug reproduced)');
      return;
    }
    assert.equal(tmux('display-message', '-p', '-t', 'shared', '#{pane_in_mode}'), '1', `${platform}: drag enters tmux scrollback`);
    const first = position(); assert.ok(first > 0, `${platform}: drag moved history`);
    await swipe(.65, .4); assert.ok(position() < first, `${platform}: reverse drag scrolls down`);
    if (tmux('display-message', '-p', '-t', 'shared', '#{pane_in_mode}') === '1') tmux('send-keys', '-t', 'shared', '-X', 'cancel');
    const draftAfter = tmux('capture-pane', '-p', '-t', 'shared');
    assert.ok(draftAfter.includes(draft), `${platform}: draft preserved`);
    assert.equal(tmux('display-message', '-p', '-t', 'shared', '#{pane_pid}'), panePid);
    // The only submitted commands are in this disposable fixture, after the
    // draft-preservation assertion. Never point this script at a live session.
    tmux('send-keys', '-t', 'shared', 'C-u');
    tmux('send-keys', '-t', 'shared', '-l', `less --mouse -N ${path.join(dir, 'history.txt')}`);
    tmux('send-keys', '-t', 'shared', 'Enter'); await sleep(400);
    const before = tmux('capture-pane', '-p', '-t', 'shared');
    await swipe(.65, .3);
    const after = tmux('capture-pane', '-p', '-t', 'shared');
    assert.notEqual(after, before, `${platform}: mouse-aware less receives the scroll`);
    assert.equal(tmux('display-message', '-p', '-t', 'shared', '#{pane_in_mode}'), '0', `${platform}: app scroll does not enter tmux copy mode`);
    tmux('send-keys', '-t', 'shared', 'q'); await sleep(150);
    assert.deepEqual(errors, [], `${platform}: no browser errors`);
    console.log(`${platform}: touch up/down, mouse-aware app, draft and pane preservation passed`);
  } finally {
    await context?.close(); child.kill('SIGTERM');
    await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve));
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  }
}
(async () => {
  try {
    fs.writeFileSync(path.join(dir, 'history.txt'), Array.from({ length: 240 }, (_, i) => `TOUCH_HISTORY_${String(i).padStart(3, '0')}`).join('\n') + '\n');
    tmux('new-session', '-d', '-s', 'shared', '-x', '80', '-y', '24', '/bin/bash --noprofile --norc');
    tmux('send-keys', '-t', 'shared', '-l', `cat ${path.join(dir, 'history.txt')}`); tmux('send-keys', '-t', 'shared', 'Enter'); await sleep(250);
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await run('linux');
    if (process.env.TOUCH_SCROLL_BASELINE !== '1') await run('mac-client');
  } finally {
    await browser?.close();
    try { tmux('kill-server'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
