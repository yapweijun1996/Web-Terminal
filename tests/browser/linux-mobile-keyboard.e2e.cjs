'use strict';
// Real Linux UI, /usr/bin/ttyd embedded client and disposable tmux. Synthetic
// visualViewport events do not establish physical iPhone Safari keyboard behavior.
// PLAYWRIGHT_MODULE=/path/to/playwright BROWSER=webkit node tests/browser/linux-mobile-keyboard.e2e.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(root, 'artifacts/lk-'));
// Unix socket paths are limited to 108 bytes; use a short private runtime.
const runtime = fs.mkdtempSync('/tmp/wt-keyboard-');
const socketName = `wt-keyboard-${process.pid}-${Date.now()}`;
const socket = path.join(runtime, 'ui.sock');
const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', socketName, ...args], { encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, child, tmuxPath;
const fixtureUI = path.join(dir, 'ui');
const baseline = file => execFileSync('git', ['show', `origin/main:linux/ui/${file}`]);
fs.cpSync(path.join(root, 'linux/ui'), fixtureUI, {recursive:true});
for (const file of ['server.js','index.html','app.js','style.css']) fs.writeFileSync(path.join(fixtureUI,file), baseline(file));
const streams = new Set();
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
  for (const stream of [client, upstream]) { streams.add(stream); stream.on('close', () => streams.delete(stream)); }
  upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
});
async function waitForSocket() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error('fixture exited');
    if (await new Promise(resolve => {
      const stream = net.connect(socket); stream.on('connect', () => { stream.destroy(); resolve(true); }); stream.on('error', () => resolve(false));
    })) return;
    await sleep(30);
  }
  throw Error('fixture socket unavailable');
}
(async () => {
  try {
    tmux('new-session', '-d', '-s', 'shared', '-x', '80', '-y', '24', '/bin/bash --noprofile --norc');
    tmuxPath = tmux('display-message', '-p', '#{socket_path}');
    const panePid = tmux('display-message', '-p', '#{pane_pid}');
    tmux('send-keys','-l', "for i in {1..200}; do echo TOUCH_HISTORY_$i; done");
    tmux('send-keys','Enter');
    for (let i = 0; i < 100 && !tmux('capture-pane','-p').includes('TOUCH_HISTORY_200'); i++) await sleep(20);
    assert.ok(tmux('capture-pane','-p').includes('TOUCH_HISTORY_200'));
    child = spawn(process.execPath, [path.join(fixtureUI, 'server.js')], {env:{...process.env, TERMINAL_RUNTIME:runtime, TERMINAL_TMUX_SOCKET:socketName, TERMINAL_TEST_HTTP:'1', TERMINAL_UPLOAD_DIR:path.join(dir, 'uploads')},stdio:'ignore'});
    await waitForSocket();
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    const fixturePid = child.pid;
    const htmlBefore = await (await fetch(origin)).text();
    for (const file of ['style.css','app.js']) {
      const initial = await fetch(`${origin}/${file}`);
      assert.equal(initial.headers.get('cache-control'), 'no-store');
      assert.equal(await initial.text(), baseline(file).toString());
      if (process.env.KEYBOARD_BASELINE !== '1') {
        const staged = path.join(fixtureUI, `${file}.staged`);
        fs.copyFileSync(path.join(root,'linux/ui',file), staged);
        fs.renameSync(staged, path.join(fixtureUI,file));
        assert.equal(await (await fetch(`${origin}/${file}`)).text(), fs.readFileSync(path.join(root,'linux/ui',file),'utf8'));
      }
    }
    assert.equal(child.pid, fixturePid); assert.equal(child.exitCode, null);
    assert.equal(await (await fetch(origin)).text(), htmlBefore, 'hot replacement keeps served HTML identical');
    assert.deepEqual(fs.readFileSync(path.join(fixtureUI,'server.js')), baseline('server.js'));
    assert.deepEqual(fs.readFileSync(path.join(root,'linux/ui/server.js')), baseline('server.js'));
    assert.deepEqual(fs.readFileSync(path.join(root,'linux/ui/index.html')), baseline('index.html'));
    const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
    browser = await engine.launch({headless:true, ...(process.env.BROWSER === 'webkit' ? {executablePath:process.env.WEBKIT_BIN || undefined} : {executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',args:['--no-sandbox']})});
    const errors = [];
    async function open({mobile = true, fallback = false} = {}) {
      const context = await browser.newContext({viewport:mobile ? {width:390,height:844} : {width:1280,height:800},hasTouch:mobile,isMobile:mobile});
      await context.addInitScript(({fallback}) => {
        if (window.parent !== window) return;
        const viewport = new EventTarget(); Object.assign(viewport, {height:844,offsetTop:0,scale:1});
        Object.defineProperty(window, 'visualViewport', {value:fallback ? undefined : viewport});
        window.setViewport = (height, offsetTop = 0, scale = 1) => {
          Object.assign(viewport, {height,offsetTop,scale}); viewport.dispatchEvent(new Event('resize')); viewport.dispatchEvent(new Event('scroll'));
        };
      }, {fallback});
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.waitForFunction(() => document.querySelector('iframe.active')?.contentWindow?.term?.element && document.querySelector('iframe.active').contentWindow.term.rows > 0 && !document.querySelector('iframe.active').contentWindow.term.options.disableStdin);
      assert.equal(await page.evaluate(() => document.querySelector('iframe.active').contentWindow.location.origin === location.origin), true, 'embedded ttyd is same-origin');
      const frame = page.frames().find(f => f.url().includes('/terminal/shared'));
      await frame.waitForFunction(() => window.webTerminalTarget?.pane);
      await sleep(250);
      return {context,page,frame};
    }
    const {context,page,frame} = await open();
    let upgrades = 0; page.on('websocket', () => upgrades++);
    const settle = () => sleep(180);
    const measure = () => page.evaluate(() => {
      const iframe = document.querySelector('iframe.active'), win = iframe.contentWindow, term = win.term;
      const rect = node => {const r = node.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,height:r.height,width:r.width};};
      const screen = win.document.querySelector('.xterm-screen');
      const cellHeight = screen.getBoundingClientRect().height / term.rows;
      const cursor = {bottom:screen.getBoundingClientRect().top + (term.buffer.active.cursorY + 1) * cellHeight};
      return {body:rect(document.body),frame:rect(iframe),screen:rect(win.document.querySelector('.xterm-screen')),cursor,rows:term.rows,cols:term.cols,focus:win.document.activeElement === term.textarea};
    });
    await frame.evaluate(() => {term.focus(); window.resizes = 0; const resize = term.resize.bind(term); term.resize = (...args) => {resizes++;resize(...args);}; window.input = []; term.onData(data => input.push(data));});
    const before = await measure();
    await page.keyboard.type('UNSUBMITTED_KEYBOARD_FIXTURE');
    await settle();
    const draftBefore = tmux('capture-pane', '-p');
    await frame.evaluate(() => {input.length = 0; resizes = 0;});
    await page.evaluate(() => {setViewport(620);setViewport(510);setViewport(420,32);}); await settle();
    const opened = await measure();
    if (process.env.KEYBOARD_BASELINE === '1') {
      assert.equal(opened.body.height,844,'negative control reproduces keyboard occlusion');
      assert.equal(opened.rows,before.rows,'unpatched embedded client does not shrink');
      await frame.evaluate(() => new Promise(resolve => term.write('\x1b[?1049l\r\n'+Array.from({length:term.options.scrollback + term.rows + 50},(_,i) => 'HISTORY_'+i).join('\r\n'),resolve)));
      await frame.evaluate(() => {term.scrollToLine(30);term.select(0,term.buffer.active.viewportY,5);});
      assert.equal(await frame.evaluate(() => term.getSelection()),'HISTO');
      await frame.evaluate(() => term.resize(term.cols,term.rows-1)); await settle();
      assert.equal(await frame.evaluate(() => term.getSelection()),'','native tmux mouse-mode reset owns selection clearing');
      console.log('Baseline native height resize: tmux mouse-mode reset clears selection');
      console.log('Linux keyboard negative control: unchanged outer height and rows reproduced');
      return;
    }
    assert.equal(opened.body.height,420); assert.equal(opened.body.top,32);
    assert.ok(opened.frame.bottom <= 452 && opened.screen.bottom <= opened.frame.height);
    assert.ok(opened.rows < before.rows); assert.equal(opened.focus,true);
    await page.screenshot({path:path.join(dir,`${process.env.BROWSER || 'chromium'}-keyboard.png`)});
    await frame.evaluate(() => new Promise(resolve => term.write('\x1b[' + term.rows + ';1HCURSOR',resolve)));
    await settle();
    const cursor = await measure();
    assert.ok(cursor.cursor && cursor.cursor.bottom <= cursor.frame.height,'last-row cursor stays above keyboard');
    const calls = await frame.evaluate(() => resizes);
    await page.evaluate(() => setViewport(420,50)); await settle();
    assert.equal(await frame.evaluate(() => resizes),calls,'offset-only pan never resizes PTY');
    await page.evaluate(() => setViewport(210,90,2)); await settle();
    assert.equal((await measure()).body.height,420,'pinch does not resize PTY');
    assert.equal(await frame.evaluate(() => resizes),calls);
    await page.evaluate(() => setViewport(0)); await settle(); assert.equal((await measure()).body.height,420);
    await page.evaluate(() => setViewport(844)); await settle(); assert.equal((await measure()).rows,before.rows);
    assert.ok(tmux('capture-pane','-p').includes('UNSUBMITTED_KEYBOARD_FIXTURE'),'draft retained');
    assert.ok(draftBefore.includes('UNSUBMITTED_KEYBOARD_FIXTURE'));
    assert.equal(tmux('display-message','-p','#{pane_pid}'),panePid);
    assert.deepEqual(await frame.evaluate(() => input),[],'layout sends no keys');
    assert.equal(upgrades,0,'layout does not reconnect websocket');
    if (process.env.BROWSER !== 'webkit') {
      const cdp = await context.newCDPSession(page);
      const rect = await frame.locator('.xterm-screen').boundingBox();
      async function swipe(from,to) {
        const x = rect.x + rect.width / 2, y = fraction => rect.y + rect.height * fraction;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:y(from),id:1}]});
        for (let i=1;i<=12;i++) {
          await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y(from+(to-from)*i/12),id:1}]});
          await sleep(12);
        }
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await settle();
      }
      await swipe(.3,.65);
      assert.equal(tmux('display-message','-p','#{pane_in_mode}'),'1','embedded outer UI touch still enters tmux history');
      const firstScroll = Number(tmux('display-message','-p','#{scroll_position}'));
      assert.ok(firstScroll>0);
      await swipe(.65,.4);
      assert.ok(Number(tmux('display-message','-p','#{scroll_position}'))<firstScroll,'reverse touch moves toward live output');
      if (tmux('display-message','-p','#{pane_in_mode}')==='1') tmux('send-keys','-X','cancel');
      assert.ok(tmux('capture-pane','-p').includes('UNSUBMITTED_KEYBOARD_FIXTURE'));
      await cdp.detach();
    }
    // Local xterm history has separate ownership from tmux copy mode.
    await frame.evaluate(() => new Promise(resolve => term.write('\x1b[?1049l\r\n'+Array.from({length:term.options.scrollback + term.rows + 50},(_,i) => 'HISTORY_'+i).join('\r\n'),resolve)));
    await frame.evaluate(() => {term.scrollToLine(30);window.historyLine=term.buffer.active.getLine(30).translateToString();});
    const history = await frame.evaluate(() => term.buffer.active.viewportY);
    assert.equal(history,30,'local history scenario uses normal scrollback, not tmux alternate screen');
    await page.evaluate(() => setViewport(430)); await settle();
    assert.equal(await frame.evaluate(() => term.buffer.active.getLine(term.buffer.active.viewportY).translateToString()),await frame.evaluate(() => historyLine),'same-width shrink preserves visible history even at scrollback capacity');
    await page.evaluate(() => setViewport(844)); await settle();
    assert.equal(await frame.evaluate(() => term.buffer.active.getLine(term.buffer.active.viewportY).translateToString()),await frame.evaluate(() => historyLine),'dismissal preserves local history');
    const scrollBefore = await page.evaluate(() => [scrollX,scrollY]);
    await frame.evaluate(() => { term.blur(); term.focus(); }); await settle();
    assert.deepEqual(await page.evaluate(() => [scrollX,scrollY]),scrollBefore,'terminal focus does not scroll outer page');
    await frame.evaluate(() => term.select(0,term.buffer.active.viewportY,5));
    const selected = await frame.evaluate(() => term.getSelection());
    await page.evaluate(() => setViewport(844,10)); await settle();
    assert.equal(await frame.evaluate(() => term.getSelection()),selected,'offset-only pan preserves selection');
    await page.evaluate(() => setViewport(422,10,2)); await settle();
    assert.equal(await frame.evaluate(() => term.getSelection()),selected,'pinch preserves selection');
    await page.evaluate(() => setViewport(844)); await settle();
    await page.evaluate(() => setViewport(430)); await settle();
    assert.equal(await frame.evaluate(() => term.getSelection()),'','same tmux mouse-mode selection ownership as native baseline');
    await frame.evaluate(() => term.clearSelection());
    // The parent controls must retain their own focus during a keyboard resize.
    await page.locator('#toolbar-menu > summary').click();
    await page.locator('#rename-tab').click(); await page.locator('#rename-input').fill('Keyboard fixture');
    await page.evaluate(() => setViewport(400,10)); await settle();
    assert.equal(await page.evaluate(() => document.activeElement.id),'rename-input');
    await page.locator('#rename-cancel').click();
    await page.locator('.mobile-keys-toggle').click(); await settle();
    assert.ok((await measure()).screen.bottom <= (await measure()).frame.height,'Keys layout refits iframe');
    assert.equal(await frame.evaluate(() => getComputedStyle(term.textarea).fontSize),'16px');
    await page.setViewportSize({width:844,height:390}); await page.evaluate(() => setViewport(240)); await settle();
    const landscape = await measure();
    assert.ok(landscape.frame.height > 0 && landscape.screen.bottom <= landscape.frame.height,'landscape screen fits');
    // Alternate screen and tmux copy mode remain owned by their application.
    await frame.evaluate(() => new Promise(resolve => term.write('\x1b[?1049hALT',resolve)));
    await page.evaluate(() => setViewport(260)); await settle();
    assert.equal(await frame.evaluate(() => term.buffer.active.type),'alternate');
    await frame.evaluate(() => new Promise(resolve => term.write('\x1b[?1049l',resolve)));
    tmux('copy-mode');
    await page.evaluate(() => setViewport(280)); await settle();
    assert.equal(tmux('display-message','-p','#{pane_in_mode}'),'1','keyboard resize preserves tmux copy mode');
    tmux('send-keys','-X','cancel');
    // A second Linux tab must not replace the first frame or its process.
    const firstFrame = await page.locator('iframe.active').getAttribute('src');
    await page.evaluate(() => { document.querySelector('#toolbar-menu').open = true; });
    await page.locator('#new-session').click();
    await page.waitForFunction(() => document.querySelectorAll('iframe').length === 2 && document.querySelector('iframe.active')?.contentWindow?.webTerminalTarget?.session !== 'shared' && document.querySelector('iframe.active')?.contentWindow?.term?.rows > 0);
    await page.evaluate(() => setViewport(270)); await settle();
    assert.equal(await page.evaluate(() => !!document.querySelector('iframe.active').contentWindow.term.textarea.style.fontSize),true,'new tab receives adapter');
    assert.equal(tmux('display-message','-t','shared','-p','#{pane_pid}'),panePid);
    await page.evaluate(() => document.querySelector('[data-session="shared"][data-action="open"]').click());
    await settle();
    assert.equal(await page.locator('iframe.active').getAttribute('src'),firstFrame);
    assert.equal(await page.evaluate(() => document.querySelectorAll('iframe').length),2,'tab switch reuses live frames');
    await page.screenshot({path:path.join(dir,`${process.env.BROWSER || 'chromium'}.png`)});
    await context.close();
    const fallback = await open({fallback:true});
    assert.equal(await fallback.page.evaluate(() => document.body.getBoundingClientRect().height === innerHeight),true,'no viewport fallback');
    await fallback.context.close();
    const desktop = await open({mobile:false});
    assert.equal(await desktop.page.evaluate(() => document.body.classList.contains('terminal-visual-viewport')),false);
    assert.equal(await desktop.frame.evaluate(() => term.textarea.style.fontSize),'');
    await desktop.context.close();
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(dir,'measurements.json'),JSON.stringify({browser:await browser.version(),before,opened,landscape,offsetOnlyResizeCount:calls},null,2));
    console.log(`${process.env.BROWSER || 'chromium'} Linux UI + embedded ttyd keyboard E2E passed; synthetic viewport only; artifacts ${dir}`);
  } finally {
    await browser?.close();
    for (const stream of streams) stream.destroy();
    proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {child.kill('SIGTERM');await new Promise(resolve => child.once('exit',resolve));}
    try {tmux('kill-server');} catch {}
    if (tmuxPath) fs.rmSync(tmuxPath,{force:true});
    fs.rmSync(runtime,{recursive:true,force:true});
  }
})().catch(error => {console.error(error);process.exitCode=1;});
