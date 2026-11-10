'use strict';
// Build first, then PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser/window-tabs.e2e.cjs.
// Uses only dedicated fixture processes, synthetic drafts and private screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tabs-')); fs.chmodSync(dir, 0o700);
const server = `wt-tabs-${process.pid}`, socket = path.join(dir, 'ttyd.sock'), upload = path.join(dir, 'upload.sock');
const tmux = (...args) => execFileSync('tmux', ['-L', server, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser, ttyd, control, env, activePage, passed = false;
const proxy = http.createServer((req, res) => {
 const upstream = http.request({ socketPath: req.url === '/__terminal_upload' ? upload : socket, method: req.method, path: req.url, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
 upstream.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end(); }); req.pipe(upstream);
});
proxy.on('upgrade', (req, client, head) => {
 const upstream = net.connect(socket, () => { upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`); for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`); upstream.write('\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
 upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
});
function startTtyd() {
 if (ttyd && (ttyd.exitCode !== null || ttyd.signalCode !== null) && fs.existsSync(socket)) fs.unlinkSync(socket);
 ttyd = spawn('ttyd', ['-i', socket, '-W', '-O', '--url-arg', '-I', path.join(root, 'client/dist/inline.html'), path.join(root, 'runtime/attach.sh')], { env, stdio: 'ignore' });
}
async function waitTtyd() {
 for(let i=0;i<100;i++) {
  const ready=await new Promise(resolve=>{const request=http.get({socketPath:socket,path:'/'},response=>{response.resume();resolve(response.statusCode===200);});request.on('error',()=>resolve(false));request.setTimeout(500,()=>{request.destroy();resolve(false);});});
  if(ready)return; if(ttyd.exitCode!==null||ttyd.signalCode!==null)throw Error('fixture ttyd exited before ready');await sleep(30);
 }
 throw Error('fixture ttyd HTTP readiness timed out');
}
async function stop(child, cleanup = false) {
 if (child && child.exitCode === null && child.signalCode === null) {
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill();
  await Promise.race([exited, sleep(3000)]);
  if (cleanup && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([exited,sleep(2000)]); }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'fixture child stopped');
 }
}
(async () => {
 try {
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  env = { ...process.env, SHELL: '/bin/sh', WEB_TERMINAL_TMUX_SERVER: server, WEB_TERMINAL_START_DIR: dir, TERMINAL_UPLOAD_SOCKET: upload, TERMINAL_UPLOAD_DIR: path.join(dir, 'images'), TERMINAL_ALLOWED_ORIGIN: origin };
  control = spawn(process.execPath, [path.join(root, 'runtime/upload-server.js')], { env, stdio: 'ignore' }); startTtyd();
  for (let i = 0; i < 100 && (!fs.existsSync(socket) || !fs.existsSync(upload)); i++) await sleep(30);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  activePage=page; page.setDefaultTimeout(15000); await page.goto(origin);
  await page.waitForSelector('#window-tabs:not([hidden])');
  const first = tmux('display-message', '-p', '-t', '=workspace:', '#{window_id}');
  const firstPane = tmux('display-message', '-p', '-t', '=workspace:', '#{pane_id}');
  const firstPid = tmux('display-message', '-p', '-t', firstPane, '#{pane_pid}');
  const view = () => page.evaluate(() => window.webTerminalTarget.session);
  const selectButton = id => page.locator(`#window-tab-list [data-window="${id}"] [data-action=select]`);
  async function waitSelected(id) { await page.waitForFunction(id => {const node=document.querySelector(`#window-tab-list .window-tab[data-window="${id}"] [data-action=select]`);return node?.getAttribute('aria-selected') === 'true' && !node.disabled;},id); }
  async function choose(id) { await selectButton(id).click(); await waitSelected(id); }
  const tab = id => page.locator(`#window-tab-list .window-tab[data-window="${id}"]`);
  const result = id => page.locator(`#window-results .window-result[data-window="${id}"]`);
  const switcher = page.locator('#window-switcher');
  async function openWindows() { if (!await switcher.isVisible()) await page.locator('#all-windows').click(); await switcher.waitFor({state:'visible'}); }
  async function search(text) { await page.locator('#window-search').fill(text); }
  async function rowAction(id, action) { await result(id).locator(`[data-action="${action}"]`).click(); }
  async function closeWindows() { if (await switcher.isVisible()) { await switcher.locator('[data-dismiss]').click(); await switcher.waitFor({state:'hidden'}); } }
  async function assertBox(selector, width, height) { const box = await page.locator(selector).boundingBox(); assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width+1 && box.y + box.height <= height+1, `${selector} stays inside ${width}x${height}`); }
  async function capture(filename,clip) { await page.waitForFunction(()=>![...document.querySelectorAll('.xterm > div')].some(node=>/^\d+x\d+$/.test(node.textContent.trim()))); await page.screenshot({path:path.join(dir,filename),...(clip?{clip}:{})}); }
  async function assertTerminalFit() { await page.waitForFunction(()=>{const box=document.querySelector('#terminal-container').getBoundingClientRect(),screen=document.querySelector('.xterm-screen').getBoundingClientRect();return screen.bottom<=box.bottom+1&&screen.right<=box.right+1&&screen.top>=box.top-1;}); const grid=await page.evaluate(()=>`${window.term.cols}|${window.term.rows}`);assert.equal(tmux('list-clients','-t',`=${await view()}:`,'-F','#{client_width}|#{client_height}'),grid,'xterm and attached tmux grid agree'); }
  async function assertSwitcherRace() {
  let releaseSelection,selectionIntercepted; const selectionGate=new Promise(resolve=>{releaseSelection=resolve;}),selectionStarted=new Promise(resolve=>{selectionIntercepted=resolve;});
  await page.route('**/__terminal_upload',async route=>{if(route.request().headers()['x-terminal-action']==='select-window'){selectionIntercepted();await selectionGate;}await route.continue();});
  await page.keyboard.press('Control+Alt+ArrowRight'); await selectionStarted; await page.keyboard.press('Control+Alt+p'); await switcher.waitFor({state:'visible'});
  assert.equal(await page.locator('#window-search').evaluate(e=>e===document.activeElement),true);
  const selectionReply=page.waitForResponse(response=>response.request().headers()['x-terminal-action']==='select-window'); releaseSelection(); await selectionReply;
  await page.waitForFunction(()=>document.querySelector('#window-tab-list [aria-selected=true]')?.disabled===false);
  assert.ok(await switcher.isVisible(),'a late window-switch response must not close a newly opened search');
  await page.unroute('**/__terminal_upload'); await closeWindows(); await page.keyboard.press('Control+Alt+ArrowLeft'); await waitSelected(first);
  }
  async function assertHideRestoreBusy() {
   await choose(first); await page.locator('.xterm-helper-textarea').focus();
   let release,started;const gate=new Promise(resolve=>{release=resolve;}),intercepted=new Promise(resolve=>{started=resolve;});
   await page.route('**/__terminal_upload',async route=>{if(route.request().headers()['x-terminal-action']==='select-window'){started();await gate;}await route.continue();});
   await page.keyboard.press('Control+Alt+w'); await intercepted; await openWindows();
   assert.ok(await result(first).locator('[data-action=restore]').isDisabled(),'Restore communicates pending target switch instead of dropping enabled clicks');
   const replied=page.waitForResponse(response=>response.request().headers()['x-terminal-action']==='select-window');release();await replied;
   await page.waitForFunction(id=>!document.querySelector(`#window-results .window-result[data-window="${id}"] [data-action=restore]`)?.disabled,first);
   await page.unroute('**/__terminal_upload'); await rowAction(first,'restore'); await waitSelected(first);await closeWindows();
  }
  if (process.env.WINDOW_TABS_STATUS_ONLY === '1') {
   await stop(ttyd); await page.waitForFunction(()=>window.webTerminalConnectionState!=='connected');
   await page.waitForFunction(()=>document.querySelector('#window-tabs-status').textContent.length>0);
   const measured=[];
   for(const [width,height,label] of [[1440,900,'desktop'],[390,844,'mobile']]) {
    await page.setViewportSize({width,height});
    const rects=await page.evaluate(()=>Object.fromEntries(Object.entries({status:'#window-tabs-status',tabs:'#window-tabs',newWindow:'#remote-toolbar [data-key="c"]',tools:'#workspace-tools > summary',terminalLabel:'#remote-toolbar > span:first-child'}).map(([key,selector])=>{const r=document.querySelector(selector).getBoundingClientRect();return [key,{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}];})));
    assert.ok(rects.status.width>0&&rects.status.height>0,'disconnected status visible');
    for(const key of ['tabs','newWindow','tools','terminalLabel']) {const a=rects.status,b=rects[key];assert.ok(!(Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.5),`status does not overlap ${key} at ${width}`);}
    await capture(`${label}-status.png`);measured.push({width,rects});
   }
   assert.equal(tmux('display-message','-p','-t',firstPane,'#{pane_pid}'),firstPid);assert.deepEqual(errors,[]);
   passed=true;console.log(JSON.stringify({result:'passed',target:'status nonintersection only',screenshots:dir,measured}));await context.close();return;
  }
  if (process.env.WINDOW_TABS_RACE_ONLY === '1') {
   tmux('new-window','-d','-t','=workspace:','-n','race-fixture','/bin/sh');
   await page.waitForFunction(()=>document.querySelectorAll('#window-tab-list .window-tab').length===2);
   await choose(first); await page.locator('.xterm-helper-textarea').focus(); await assertSwitcherRace(); await assertHideRestoreBusy();
   passed=true; console.log('PASS delayed selection does not close new switcher'); await context.close(); return;
  }

  assert.equal(tmux('show-options', '-Av', '-t', `=${await view()}:`, 'status'), 'off');
  assert.equal(tmux('show-options', '-Av', '-t', '=workspace:', 'status'), 'on');
  await page.route('**/__terminal_upload', route => route.request().headers()['x-terminal-action'] === 'windows' ? route.fulfill({status:503, body:'{}'}) : route.continue());
  await page.waitForFunction(() => document.querySelector('#window-tabs').hidden);
  assert.equal(tmux('show-options', '-Av', '-t', `=${await view()}:`, 'status'), 'on');
  await page.unroute('**/__terminal_upload'); await page.waitForSelector('#window-tabs:not([hidden])');
  assert.equal(tmux('show-options', '-Av', '-t', `=${await view()}:`, 'status'), 'off');

  await page.waitForFunction(() => window.term.modes.mouseTrackingMode !== 'none');
  const contextMenu = (target, options = {}) => page.evaluate(({target, options}) => {
   const event = new PointerEvent('contextmenu', {bubbles:true, cancelable:true, pointerType:'mouse', ...options});
   document.querySelector(target).dispatchEvent(event); return event.defaultPrevented;
  }, {target, options});
  assert.equal(await contextMenu('#terminal-container'), true);
  assert.equal(await contextMenu('#terminal-container', {shiftKey:true}), false);
  assert.equal(await contextMenu('#terminal-container', {pointerType:'touch'}), false);
  assert.equal(await contextMenu('#remote-toolbar'), false);
  const marker = path.join(dir, 'right-click-report');
  tmux('bind-key', '-n', 'MouseDown3Pane', 'run-shell', `touch ${marker}`);
  const screen = await page.locator('.xterm-screen').boundingBox(); await page.mouse.click(screen.x+50, screen.y+50, {button:'right'});
  for (let i=0; i<50 && !fs.existsSync(marker); i++) await sleep(30);
  assert.ok(fs.existsSync(marker), 'tmux receives actual right-button report');
  tmux('set-option', '-t', `=${await view()}:`, 'mouse', 'off'); await page.waitForFunction(() => window.term.modes.mouseTrackingMode === 'none');
  assert.equal(await contextMenu('#terminal-container'), false); tmux('set-option', '-t', `=${await view()}:`, 'mouse', 'on');

  await openWindows(); await page.locator('#window-search').press('Escape'); await switcher.waitFor({state:'hidden'}); assert.equal(await page.locator('#all-windows').evaluate(e=>e===document.activeElement),true,'switcher Escape returns focus');

  // End is explicit and guarded, even before adding the overflow fixture.
  await openWindows(); await rowAction(first, 'end'); await page.waitForSelector('#close-window-dialog[open]');
  assert.ok(await page.locator('#close-window-dialog [data-confirm]').isDisabled());
  await page.locator('#close-window-dialog [data-cancel]').click(); await closeWindows();

  const windows = [first];
  for (let i=1; i<30; i++) windows.push(tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-t', '=workspace:', '-n', `Fixture ${String(i).padStart(2,'0')}`, i===27?'/bin/sleep 900':'/bin/sh'));
  await page.waitForFunction(() => document.querySelectorAll('#window-tab-list .window-tab').length === 30);
  assert.equal(tmux('list-windows', '-t', '=workspace:', '-F', '#{window_id}').split('\n').length, 30);
  const runningJobPid=tmux('display-message','-p','-t',windows[27],'#{pane_pid}');
  const draft = `printf DO_NOT_EXECUTE > ${path.join(dir,'draft-was-submitted')}`;
  tmux('send-keys', '-t', firstPane, '-l', draft);
  const preserved = () => { assert.equal(tmux('display-message', '-p', '-t', firstPane, '#{pane_pid}'), firstPid); assert.ok(tmux('capture-pane', '-p', '-J', '-t', firstPane).includes('DO_NOT_EXECUTE')); assert.ok(!fs.existsSync(path.join(dir,'draft-was-submitted'))); assert.equal(tmux('display-message','-p','-t',windows[27],'#{pane_pid}'),runningJobPid,'active sleep job survives hide/restore/reconnect'); };

  for (const [width,height,name] of [[1440,900,'desktop1440'],[1280,800,'desktop1280'],[768,1024,'tablet768'],[390,844,'mobile390'],[640,400,'zoom200-equivalent'],[390,450,'mobile-compact-height']]) {
   await page.setViewportSize({width,height}); await choose(windows[29]);
   await page.waitForFunction(() => document.querySelector('#window-tab-list [role=tab][aria-selected=true]'));
   const geometry = await page.evaluate(() => { const strip=document.querySelector('#window-tabs').getBoundingClientRect(), list=document.querySelector('#window-tab-list'), selected=list.querySelector('[role=tab][aria-selected=true]')?.getBoundingClientRect(), bounds=list.getBoundingClientRect(); return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,height:strip.height,overflow:list.scrollWidth>list.clientWidth,selected:selected&&{left:selected.left,right:selected.right},bounds:{left:bounds.left,right:bounds.right}}; });
   assert.ok(geometry.documentWidth<=geometry.viewport+1,'no horizontal document overflow'); assert.ok(geometry.height>=40&&geometry.height<=44,'40–44px tab strip'); assert.ok(geometry.overflow,'30 tabs scroll inside strip');
   assert.ok(geometry.selected && geometry.selected.left>=geometry.bounds.left-1 && geometry.selected.right<=geometry.bounds.right+1,'selected tab scrolled into view');
   await capture(`${name}-tabs.png`); if(width===1440) await capture('desktop-strip-preview.png',{x:0,y:0,width,height:120});
   await openWindows(); await assertBox('#window-switcher',width,height);
   for (const index of [1,15,29]) { await search(`Fixture ${String(index).padStart(2,'0')}`); assert.equal(await result(windows[index]).count(),1); }
   await search('');
   for (const [position,fraction] of [['top',0],['middle',0.5],['bottom',1]]) {
    await page.locator('#window-results').evaluate((el,f)=>el.scrollTo(0,(el.scrollHeight-el.clientHeight)*f),fraction);
    const scroll=await page.locator('#window-results').evaluate(el=>({top:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
    assert.ok(scroll.max>0,'switcher list scrolls internally'); assert.ok(Math.abs(scroll.top-scroll.max*fraction)<2,`switcher reaches ${position}`);
    await assertBox('#window-search',width,height); await assertBox('#window-switcher',width,height);
    await capture(`${name}-switcher-${position}.png`);
   }
   await closeWindows(); preserved();
  }
  await page.setViewportSize({width:390,height:844});
  assert.match(await page.locator('#status-input').textContent(), /Not reported/);
  assert.match(await page.locator('#status-sharing').textContent(), /Not reported/);
  const statusLayout = await page.locator('#workspace-status').evaluate(bar => {
   const bounds=bar.getBoundingClientRect();
   return { height:bounds.height, scrollWidth:bar.scrollWidth, clientWidth:bar.clientWidth, items:[...bar.children].map(el=>{const r=el.getBoundingClientRect(); return {id:el.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,fontSize:parseFloat(getComputedStyle(el).fontSize)};}) };
  });
  assert.ok(statusLayout.height<=64 && statusLayout.height>30, 'mobile status uses two compact rows');
  assert.ok(statusLayout.scrollWidth<=statusLayout.clientWidth, 'mobile status does not scroll horizontally');
  for (const item of statusLayout.items) {
   assert.ok(item.left>=0 && item.right<=390 && item.fontSize>=12 && item.scrollHeight<=item.clientHeight, `${item.id} is visible without clipping`);
  }
  assert.equal(statusLayout.items.length,4);
  await assertTerminalFit();
  await page.locator('#workspace-tools > summary').click();
  const tools=page.locator('#workspace-tools');
  for (const name of ['Keys','Return to live','Previous','Next','Upload image']) assert.ok(await tools.getByRole('button',{name,exact:true}).isVisible(),`${name} remains available in Workspace tools`);
  await tools.locator('.display-controls > summary').click(); await assertBox('#workspace-tools .display-controls section',390,844);
  const oldFont=await page.evaluate(()=>window.term.options.fontSize); await tools.getByRole('button',{name:'Larger text',exact:true}).click(); await page.waitForFunction(old=>window.term.options.fontSize>old,oldFont); await tools.locator('.display-controls > summary').click(); await assertTerminalFit();
  await tools.getByRole('button',{name:'Keys',exact:true}).click(); await page.locator('#mobile-keys').waitFor({state:'visible'}); await assertBox('#mobile-keys',390,844); await assertTerminalFit();
  await tools.getByRole('button',{name:'Keys',exact:true}).click();
  await tools.locator('#terminal-diagnostics > summary').click(); await assertBox('#terminal-diagnostics section',390,844); await tools.locator('#terminal-diagnostics > summary').click();
  const beforeNav=await page.evaluate(()=>window.webTerminalTarget.windowIndex);
  await tools.getByRole('button',{name:'Next',exact:true}).click(); await page.waitForFunction(before=>window.webTerminalTarget.windowIndex!==before,beforeNav);
  await tools.getByRole('button',{name:'Previous',exact:true}).click(); await page.waitForFunction(before=>window.webTerminalTarget.windowIndex===before,beforeNav);
  await tools.getByRole('button',{name:'Return to live',exact:true}).click(); await page.getByText('tmux live requested; app scroll unknown',{exact:true}).waitFor();
  const chooserPromise=page.waitForEvent('filechooser'); await tools.getByRole('button',{name:'Upload image',exact:true}).click(); const chooser=await chooserPromise; await chooser.setFiles([]);
  await capture('mobile-workspace-tools.png'); await page.locator('#workspace-tools > summary').click();
  await page.setViewportSize({width:1280,height:800}); await choose(first);
  await tab(first).locator('[data-action=hide]').click(); await tab(first).waitFor({state:'detached'}); assert.equal(await tab(first).count(),0); preserved();
  await openWindows(); await search('node'); await search(''); assert.equal(await result(first).count(),1); await rowAction(first,'restore'); await closeWindows(); await tab(first).waitFor(); preserved();
  // Hiding every view produces a reversible placeholder, never an End request.
  await choose(first);
  for (const id of windows.slice(1).concat(first)) { await tab(id).locator('[data-action=hide]').click(); await tab(id).waitFor({state:'detached'}); }
  await page.locator('#window-empty-state').waitFor({state:'visible'}); preserved();
  await capture('all-hidden.png');
  await openWindows(); await search('');
  for (const id of windows) { await rowAction(id,'restore'); await waitSelected(id); if (!await switcher.isVisible()) await openWindows(); }
  await closeWindows(); await page.waitForFunction(()=>document.querySelectorAll('#window-tab-list .window-tab').length===30); preserved();
  await openWindows(); await search('Fixture 15'); await rowAction(windows[15],'rename');
  await page.locator('#rename-window-dialog input[name=displayName]').fill('Renamed fixture'); await page.locator('#rename-window-dialog').getByRole('button',{name:'Save',exact:true}).click();
  if (await switcher.isVisible()) await search('Renamed fixture'); else await openWindows();
  await rowAction(windows[15],'pin'); await closeWindows();
  await page.reload(); await page.waitForSelector('#window-tabs:not([hidden])'); assert.match(await tab(windows[15]).textContent(),/Renamed fixture/); assert.equal(await tab(windows[15]).getAttribute('data-pinned'),'true'); preserved();
  // Compare order after accessible reordering and drag/drop, then reload it.
  const tabOrder=()=>page.locator('#window-tab-list .window-tab').evaluateAll(items=>items.map(e=>e.dataset.window));
  await openWindows(); await search('Fixture 05'); await rowAction(windows[5],'move-left'); await closeWindows(); const moved=await tabOrder(); assert.ok(moved.indexOf(windows[5])<moved.indexOf(windows[4]),'menu move-left changes order');
  // The larger accessible controls widen tabs; keep both drag endpoints visible.
  await page.setViewportSize({width:1920,height:800}); await page.locator('#window-tab-list').evaluate(el=>{el.scrollLeft=0;});
  await tab(windows[7]).dragTo(tab(windows[3])); const dragged=await tabOrder(); assert.notDeepEqual(dragged,moved,'actual drag/drop changes order');
  await page.setViewportSize({width:1280,height:800});
  await page.reload(); await page.waitForSelector('#window-tabs:not([hidden])'); assert.deepEqual(await tabOrder(),dragged,'order survives reload'); preserved();

  // Shortcut bytes must not enter the existing unsubmitted fixture draft.
  await choose(first); await page.locator('.xterm-helper-textarea').focus();
  const reserved = await page.evaluate(()=>[['Tab',{ctrlKey:true}],['w',{metaKey:true}],['Tab',{metaKey:true}]].map(([key,modifiers])=>{const event=new KeyboardEvent('keydown',{key,code:key==='w'?'KeyW':'Tab',bubbles:true,cancelable:true,...modifiers});document.querySelector('.xterm-helper-textarea').dispatchEvent(event);return event.defaultPrevented;}));
  assert.deepEqual(reserved,[false,false,false],'OS/browser shortcuts are not hijacked');
  await page.evaluate(()=>{window.fixtureShortcutBytes=[];window.fixtureShortcutSubscription=window.term.onData(data=>window.fixtureShortcutBytes.push(data));});
  await assertSwitcherRace(); await assertHideRestoreBusy();
  await choose(first); await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Control+Alt+w'); await tab(first).waitFor({state:'detached'}); assert.equal(await tab(first).count(),0); preserved();
  await openWindows(); await search(''); await rowAction(first,'restore'); await waitSelected(first); await closeWindows(); await tab(first).waitFor();
  const shortcutBytes=await page.evaluate(()=>{window.fixtureShortcutSubscription.dispose();return window.fixtureShortcutBytes;}); assert.deepEqual(shortcutBytes,[],'workspace shortcuts send no terminal input');
  await selectButton(windows[3]).focus(); await page.keyboard.press('Home'); await waitSelected(await page.locator('#window-tab-list [data-action=select]').first().getAttribute('data-window'));
  assert.equal(await page.locator('#window-tab-list [data-action=select]').first().evaluate(e=>e===document.activeElement),true,'Home retains tab focus');
  await page.keyboard.press('End'); await waitSelected(await page.locator('#window-tab-list [data-action=select]').last().getAttribute('data-window'));
  assert.equal(await page.locator('#window-tab-list [data-action=select]').last().evaluate(e=>e===document.activeElement),true);
  await tab(windows[29]).locator('[data-action=menu]').click(); await page.locator('#window-tab-menu').waitFor({state:'visible'}); await assertBox('#window-tab-menu',1280,800);
  assert.equal(await page.locator('#window-tab-menu button').first().evaluate(e=>e===document.activeElement),true); await page.keyboard.press('ArrowDown'); assert.equal(await page.locator('#window-tab-menu button').nth(1).evaluate(e=>e===document.activeElement),true);
  await capture('desktop-menu.png'); await page.keyboard.press('Escape');

  // Captured stable identity cannot target a replacement with the same numeric index.
  await openWindows(); await search('Fixture 29'); await rowAction(windows[29],'end'); await page.waitForSelector('#close-window-dialog[open]');
  assert.equal(await page.locator('#close-window-dialog [data-cancel]').evaluate(e=>e===document.activeElement),true);
  const oldIndex=tmux('display-message','-p','-t',windows[29],'#{window_index}'); tmux('kill-window','-t',windows[29]);
  const replacement=tmux('new-window','-d','-P','-F','#{window_id}','-t',`workspace:${oldIndex}`,'-n','replacement','/bin/sh');
  await page.locator('#close-window-dialog [data-confirm]').click(); await page.waitForFunction(()=>document.querySelector('#close-window-dialog [data-error]').textContent.length>0);
  assert.ok(tmux('list-windows','-t','workspace','-F','#{window_id}').includes(replacement)); await page.locator('#close-window-dialog [data-cancel]').click(); await closeWindows(); preserved();

  const ending=windows[28], endingPid=tmux('display-message','-p','-t',ending,'#{pane_pid}');
  await openWindows(); await search('Fixture 28'); await rowAction(ending,'end'); await page.waitForSelector('#close-window-dialog[open]');
  await page.setViewportSize({width:390,height:844}); await assertBox('#close-window-dialog',390,844); await capture('mobile-end-modal.png');
  await page.locator('#close-window-dialog [data-cancel]').click(); assert.equal(tmux('display-message','-p','-t',ending,'#{pane_pid}'),endingPid);
  await openWindows(); await search('Fixture 28'); await rowAction(ending,'end'); await page.locator('#close-window-dialog [data-confirm]').click();
  await page.waitForFunction(()=>!document.querySelector('#close-window-dialog').open); assert.ok(!tmux('list-windows','-t','workspace','-F','#{window_id}').split('\n').includes(ending)); await closeWindows(); preserved();

  await page.evaluate(()=>{const key='web-terminal-tabs-v1',data=JSON.parse(localStorage.getItem(key)),server=window.webTerminalTarget.serverPid;data.servers[server]['@999999']={name:'STALE FAKE',hidden:false,pinned:true,order:0};data.servers[server].invalid={name:'INVALID FAKE'};localStorage.setItem(key,JSON.stringify(data));});
  await page.reload(); await page.waitForSelector('#window-tabs:not([hidden])'); assert.equal(await page.getByText('STALE FAKE',{exact:true}).count(),0); assert.equal(await page.getByText('INVALID FAKE',{exact:true}).count(),0); preserved();
  const deniedStoragePage=await context.newPage(); await deniedStoragePage.addInitScript(()=>{const original=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key==='web-terminal-tabs-v1')throw Error('fixture denied storage');return original.call(this,key);};});
  await deniedStoragePage.goto(origin); await deniedStoragePage.waitForSelector('#window-tabs:not([hidden])'); await deniedStoragePage.getByText('Browser storage unavailable; preferences last for this page.',{exact:true}).first().waitFor(); await deniedStoragePage.close();
  // A second mobile-width client can trigger an asynchronous shell redraw.
  for (let i=0; i<100 && !tmux('capture-pane','-p','-J','-t',firstPane).includes('DO_NOT_EXECUTE'); i++) await sleep(20);
  preserved();

  await stop(ttyd); await page.waitForFunction(()=>window.webTerminalConnectionState!=='connected'); preserved(); await page.waitForFunction(()=>document.querySelector('#window-tabs').dataset.connection==='disconnected'); assert.ok(await page.locator('#window-tabs').isVisible()); assert.ok(await page.locator('#window-tab-list [data-action=select]').first().isDisabled());
  await capture('disconnected.png');
  startTtyd(); await waitTtyd(); await page.waitForFunction(()=>window.webTerminalConnectionState==='connected'); await page.waitForSelector('#window-tabs:not([hidden])'); preserved();
  assert.equal(tmux('show-options','-Av','-t','=workspace:','status'),'on'); assert.deepEqual(errors,[]);
  passed=true; console.log(JSON.stringify({result:'passed',screenshots:dir,windows:30,checked:['40–44px single strip','1440/1280/768/390,640x400 equivalent200%,390x450 viewport geometry','overflow/search','hide/restore and unsent draft/PID','rename/pin/menu reorder/drag persist','CtrlAlt and tab keyboard focus','End stable identity and last-window guard','actual disconnect/reconnect','native fallback and mouse menu regression','no page errors']})); await context.close();
 } finally {
  if (!passed && activePage && !activePage.isClosed()) { await activePage.screenshot({path:path.join(dir,'failure.png')}).catch(()=>{}); console.error('Failure artifacts: '+dir); }
  await browser?.close(); for (const child of [ttyd,control]) await stop(child,true);
  proxy.closeAllConnections(); proxy.close(); try { tmux('kill-server'); } catch {}
  for (const entry of fs.readdirSync(dir)) if (!entry.endsWith('.png')) fs.rmSync(path.join(dir,entry),{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
