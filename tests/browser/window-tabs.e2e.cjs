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
  const shots = '/private/tmp/omp-shots/final3';
  async function checkChromeAndCapture(target, label) {
   fs.mkdirSync(shots, {recursive:true});
   for (const theme of ['light','dark']) for (const [width,height] of [[1919,883],[1280,720],[768,1024],[390,844]]) {
    await target.emulateMedia({colorScheme:theme}); await target.setViewportSize({width,height});
    await target.waitForFunction(() => {
     const box=document.querySelector('#terminal-container').getBoundingClientRect(), screen=document.querySelector('.xterm-screen').getBoundingClientRect();
     const cell=window.term?._core?._renderService?.dimensions?.css?.cell?.height;
     return cell>0 && screen.top+window.term.rows*cell<=Math.min(box.bottom,innerHeight)+1 && screen.right<=box.right+1 && document.documentElement.scrollHeight<=innerHeight && document.documentElement.scrollWidth<=innerWidth;
    });
    const metrics=await target.evaluate(() => {
     const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};};
     const box=rect('#terminal-container'),screen=rect('.xterm-screen'),items=[...document.querySelectorAll('.workspace-status-item')].map(e=>({text:e.textContent,font:parseFloat(getComputedStyle(e).fontSize),rect:(()=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()}));
     const tokens=getComputedStyle(document.documentElement), lum=value=>{const hex=value.trim().slice(1);const channels=[0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;};
     const contrast=(a,b)=>{const values=[lum(tokens.getPropertyValue(a)),lum(tokens.getPropertyValue(b))].sort((x,y)=>y-x);return (values[0]+0.05)/(values[1]+0.05);};
     const contrastRatios=['--text','--muted','--status-ok','--status-warn','--status-error','--status-unknown','--status-busy'].map(color=>contrast(color,'--panel')).concat(contrast('--text','--control'));
     return {box,screen,items,contrastRatios,header:rect('#remote-toolbar'),title:rect('#remote-toolbar > span:first-child'),status:rect('#workspace-status'),tools:rect('#workspace-tools > summary'),rows:window.term.rows,cell:window.term._core._renderService.dimensions.css.cell.height,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth};
    });
    assert.ok(metrics.scrollHeight<=height && metrics.scrollWidth<=width, `${label} ${theme} ${width} viewport does not overflow`);
    assert.ok(metrics.rows*metrics.cell<=metrics.box.height && metrics.screen.top+metrics.rows*metrics.cell<=Math.min(metrics.box.bottom,height)+1, `${label} ${theme} ${width} terminal rows fit`);
    assert.ok(metrics.contrastRatios.every(value=>value>=4.5), `${theme} chrome text tokens meet 4.5:1: ${metrics.contrastRatios}`);
    assert.equal(metrics.items.length,4); for(const item of metrics.items) assert.ok(item.text && item.font>=12 && item.rect.left>=0 && item.rect.right<=width, `${label} ${theme} ${width} status visible`);
    assert.equal(metrics.title.left,16,`${label} ${theme} ${width} title padding`);
    if(width>=900) {
     assert.equal(metrics.header.height,48, 'desktop header is 48px');
     assert.ok(metrics.status.top>=metrics.header.top && metrics.status.bottom<=metrics.header.bottom, 'desktop status is in header');
     assert.equal(metrics.tools.right,width-16, 'desktop tools right padding');
    } else {
     assert.ok(metrics.status.top>=metrics.header.top+48 && metrics.status.bottom<=metrics.header.bottom && metrics.status.height>30, 'narrow status uses a separate two-row grid');
     assert.ok(metrics.items[0].rect.top===metrics.items[1].rect.top && metrics.items[2].rect.top===metrics.items[3].rect.top && metrics.items[2].rect.top>metrics.items[0].rect.top, 'narrow indicators form two rows');
    }
    await target.waitForFunction(()=>![...document.querySelectorAll('.xterm > div')].some(node=>/^\d+x\d+$/.test(node.textContent.trim())));
    await target.screenshot({path:path.join(shots,`${label}-${width}x${height}-${theme}.png`)});
   }
  }
  // Measure the actual rendered header rather than inferring separation from its
  // parent boxes: an out-of-flow overlay can otherwise pass the layout checks.
  async function headerGeometry(target, plusOnly=false) {
   return target.evaluate(plusOnly => {
    const selectors=plusOnly ? ['#remote-toolbar [data-key="c"]'] :
     ['#remote-toolbar > span:first-child','#workspace-status',
      '.workspace-status-item','#window-tabs-status','#workspace-tools > summary',
      '#remote-toolbar [data-key="c"]','#window-tabs','#all-windows'];
    const nodes=[...new Set(selectors.flatMap(selector=>[...document.querySelectorAll(selector)]))];
    const visible=node=>{const style=getComputedStyle(node),r=node.getBoundingClientRect();return style.display!=='none' && style.visibility==='visible' && r.width>0 && r.height>0 && node.getClientRects().length>0;};
    const shown=nodes.filter(visible), problems=[];
    const name=node=>node.id || node.getAttribute('data-key') || node.className || node.tagName;
    const intersects=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>0.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>0.5;
    for (const [i,node] of shown.entries()) {
     const r=node.getBoundingClientRect(), label=name(node);
     if(r.left < -0.5 || r.top < -0.5 || r.right > innerWidth+0.5 || r.bottom > innerHeight+0.5) problems.push(`${label} outside viewport`);
     for(let parent=node.parentElement;parent;parent=parent.parentElement) {
      const style=getComputedStyle(parent),p=parent.getBoundingClientRect();
      if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (r.left<p.left-0.5 || r.right>p.right+0.5)) problems.push(`${label} clipped horizontally by ${name(parent)}`);
      if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (r.top<p.top-0.5 || r.bottom>p.bottom+0.5)) problems.push(`${label} clipped vertically by ${name(parent)}`);
     }
     for(const textNode of [node,...node.querySelectorAll('*')]) {
      if(visible(textNode) && [...textNode.childNodes].some(child=>child.nodeType===Node.TEXT_NODE && child.textContent.trim()) && parseFloat(getComputedStyle(textNode).fontSize)<12) problems.push(`${label} text below 12px`);
     }
     const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
     if(!hit || !(node===hit || node.contains(hit))) problems.push(`${label} center hit ${hit ? name(hit) : 'nothing'}`);
     for(const other of shown.slice(i+1)) if(!node.contains(other) && !other.contains(node) && intersects(r,other.getBoundingClientRect())) problems.push(`${label} intersects ${name(other)}`);
    }
    if(!plusOnly) {
     const status=document.querySelector('#window-tabs-status'),style=getComputedStyle(status);
     if(status.getAttribute('role')!=='status' || !status.getAttribute('aria-live') || status.getAttribute('aria-live')==='off') problems.push('window status is not live');
     if(!visible(status)) problems.push('injected window status is not visible');
     if(style.position==='fixed' || style.position==='absolute') problems.push('window status is not in flow');
     if(style.textOverflow!=='ellipsis' || style.overflowX!=='hidden' || style.whiteSpace!=='nowrap') problems.push('window status does not ellipsize');
     if(status.scrollWidth<=status.clientWidth) problems.push('injected status did not overflow');
    } else if(shown.length!==1) problems.push('New window is not visible');
    return problems;
   },plusOnly);
  }
  async function checkHeaderMatrix(target, label) {
   const output='/private/tmp/omp-shots/final4';
   fs.mkdirSync(output,{recursive:true});
   const sizes=[[320,600],[390,844],[480,800],[768,900],[900,720],[1039,768],[1280,720],[1440,900],[1919,883]];
   await target.locator('.xterm-helper-textarea').focus();
   await target.keyboard.press('Control+Alt+Shift+T');
   assert.ok(await target.locator('#workspace-tools > summary').evaluate(node=>node===document.activeElement),`${label} toolbar shortcut focuses the visible disclosure`);
   const longStatus='A deliberately long window status message to test clipping and layout '.repeat(8);
   // Recreate the old fixed overlay only in this page, then prove the same
   // geometry detector catches it. No source or built CSS is changed.
   await target.setViewportSize({width:1280,height:720});
   await target.locator('#window-tabs-status').evaluate((node,text)=>{
    window.__headerOriginalStatus=node.textContent; node.textContent=text;
    window.__headerStatusObserver=new MutationObserver(()=>{if(node.textContent!==text) node.textContent=text;});
    window.__headerStatusObserver.observe(node,{childList:true,characterData:true,subtree:true});
    node.style.cssText='pointer-events:none;position:fixed;top:0;left:84px;right:200px;height:var(--workspace-toolbar-height);box-sizing:border-box;z-index:10;padding:0 8px;background:var(--panel);color:var(--text);font:12px/var(--workspace-toolbar-height) system-ui;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
   },longStatus);
   const regression=await headerGeometry(target);
   assert.ok(regression.some(problem=>problem.includes('intersects')),`old fixed overlay must cause a detected intersection: ${regression.join('; ')}`);
   assert.throws(()=>assert.deepEqual(regression,[]),{name:'AssertionError'},'the normal geometry assertion fails with the old fixed CSS');
   console.log(`Old fixed overlay regression (${label}): ${regression.join('; ')}`);
   await target.locator('#window-tabs-status').evaluate(node=>{window.__headerStatusObserver.disconnect();node.removeAttribute('style');node.textContent=window.__headerOriginalStatus;delete window.__headerStatusObserver;delete window.__headerOriginalStatus;});
   for(const theme of ['light','dark']) for(const [width,height] of sizes) {
    await target.emulateMedia({colorScheme:theme}); await target.setViewportSize({width,height});
    await target.waitForFunction(()=>window.term?._core?._renderService?.dimensions?.css?.cell?.height>0);
    const tools=target.locator('#workspace-tools'), plus=target.locator('#remote-toolbar [data-key="c"]');
    if(await tools.evaluate(node=>node.open)) await tools.locator(':scope > summary').click();
    await tools.locator(':scope > summary').click();
    if(label==='absent') {
     assert.ok(await plus.isHidden() || await plus.isDisabled(),'New window is hidden or disabled when controls are absent');
     if(await plus.isVisible()) assert.ok(await plus.getAttribute('title'),'disabled New window explains why');
    } else {
     assert.ok(await plus.isVisible() && !await plus.isDisabled(),'New window is reachable and enabled through Workspace tools');
     for(const disabled of [false,true]) {
      await plus.evaluate((node,value)=>{node.disabled=value;},disabled);
      const problems=await headerGeometry(target,true);
      assert.deepEqual(problems,[],`${label} ${theme} ${width} New window disabled=${disabled}: ${problems.join('; ')}`);
      await target.waitForFunction(()=>![...document.querySelectorAll('.xterm > div')].some(node=>/^\d+x\d+$/.test(node.textContent.trim())));
      await target.screenshot({path:path.join(output,`${label}-plus-${disabled?'disabled':'enabled'}-${width}x${height}-${theme}.png`)});
     }
     await plus.evaluate(node=>{node.disabled=false;});
    }
    await tools.locator(':scope > summary').click();
    await target.locator('#window-tabs-status').evaluate((node,text)=>{
     window.__headerOriginalStatus=node.textContent;
     node.textContent=text;
     window.__headerStatusObserver=new MutationObserver(()=>{if(node.textContent!==text) node.textContent=text;});
     window.__headerStatusObserver.observe(node,{childList:true,characterData:true,subtree:true});
    },longStatus);
    const problems=await headerGeometry(target);
    assert.deepEqual(problems,[],`${label} ${theme} ${width}: ${problems.join('; ')}`);
    await tools.locator(':scope > summary').click();
    for(const disabled of label==='present' ? [false,true] : [false]) {
     if(label==='present') await plus.evaluate((node,value)=>{node.disabled=value;},disabled);
     const openProblems=await headerGeometry(target);
     assert.deepEqual(openProblems,[],`${label} ${theme} ${width} tools open disabled=${disabled}: ${openProblems.join('; ')}`);
    }
    if(label==='present') await plus.evaluate(node=>{node.disabled=false;});
    await tools.locator(':scope > summary').click();
    await target.locator('#window-tabs-status').evaluate(node=>{window.__headerStatusObserver.disconnect();node.textContent=window.__headerOriginalStatus;delete window.__headerStatusObserver;delete window.__headerOriginalStatus;});
    await target.waitForFunction(()=>![...document.querySelectorAll('.xterm > div')].some(node=>/^\d+x\d+$/.test(node.textContent.trim())));
    await target.screenshot({path:path.join(output,`${label}-${width}x${height}-${theme}.png`)});
   }
  }
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
  assert.match(await page.locator('#window-tabs-status').textContent(), /Windows unavailable/, 'a previously reachable control service failure warns');
  assert.equal(tmux('show-options', '-Av', '-t', `=${await view()}:`, 'status'), 'on');
  await page.unroute('**/__terminal_upload'); await page.waitForSelector('#window-tabs:not([hidden])');
  assert.equal(tmux('show-options', '-Av', '-t', `=${await view()}:`, 'status'), 'off');
  await checkChromeAndCapture(page,'present');
  await checkHeaderMatrix(page,'present');
  const absent = await context.newPage();
  await absent.route('**/__terminal_upload', route => route.fulfill({status:404, contentType:'text/plain', body:'Not Found'}));
  await absent.goto(origin);
  await absent.waitForFunction(()=>window.webTerminalConnectionState==='connected' && window.webTerminalTarget);
  await absent.waitForFunction(()=>[...document.querySelectorAll('#terminal-diagnostics p')].some(p=>p.textContent==='Window controls: not provided on this host' && !p.hidden));
  assert.ok(await absent.locator('#window-tabs').isHidden(), 'no browser tabs without a control service');
  assert.doesNotMatch(await absent.locator('#window-tabs-status').textContent(), /Windows unavailable/, 'no unavailable warning without a control service');
  await absent.locator('#workspace-tools > summary').click(); await absent.locator('#terminal-diagnostics > summary').click();
  assert.ok(await absent.getByText('Window controls: not provided on this host',{exact:true}).isVisible(),'absence explained in Details');
  await absent.locator('#workspace-tools > summary').click();
  const absentView=await absent.evaluate(()=>window.webTerminalTarget.session);
  const absentPane=await absent.evaluate(()=>window.webTerminalTarget.pane);
  assert.equal(tmux('show-options','-Av','-t',`=${absentView}:`,'status'),'on','native tmux status stays visible');
  await absent.locator('.xterm-helper-textarea').focus();
  await absent.keyboard.type('echo HEADER_FIXTURE_INPUT_OK'); await absent.keyboard.press('Enter');
  const outputReceived=()=>/^HEADER_FIXTURE_INPUT_OK\s*$/m.test(tmux('capture-pane','-p','-J','-t',absentPane));
  for(let i=0;i<100 && !outputReceived();i++) await sleep(30);
  assert.ok(outputReceived(),'terminal input executes in tmux without window controls');
  await checkChromeAndCapture(absent,'absent'); await checkHeaderMatrix(absent,'absent'); await absent.close();
  for (const reply of [{status:405,contentType:'text/plain',body:'Method Not Allowed'},{status:200,contentType:'application/json',body:'<html>not a control service</html>'}]) {
   const probe=await context.newPage(); await probe.route('**/__terminal_upload', route=>route.fulfill(reply)); await probe.goto(origin);
   await probe.waitForFunction(()=>[...document.querySelectorAll('#terminal-diagnostics p')].some(p=>p.textContent==='Window controls: not provided on this host' && !p.hidden));
   assert.ok(await probe.locator('#window-tabs').isHidden()); assert.doesNotMatch(await probe.locator('#window-tabs-status').textContent(),/Windows unavailable/); await probe.close();
  }
  const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const touch=await touchContext.newPage(); await touch.goto(origin); await touch.waitForSelector('#window-tabs:not([hidden])');
  assert.equal(await touch.evaluate(()=>matchMedia('(pointer: coarse)').matches),true,'touch fixture uses a coarse pointer');
  for(const selector of ['#workspace-tools > summary','#all-windows','.window-tab [data-action=select]','.window-tab [data-action=hide]','.window-tab [data-action=menu]']) {
   const box=await touch.locator(selector).first().boundingBox(); assert.ok(box && box.width>=44 && box.height>=44,`${selector} has a 44px touch target`);
  }
  await touch.locator('#workspace-tools > summary').click();
  const newWindowBox=await touch.getByRole('button',{name:'New window'}).boundingBox();
  assert.ok(newWindowBox && newWindowBox.width>=44 && newWindowBox.height>=44,'New window retains a 44px target in Workspace tools');
  await touchContext.close();

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
  const draft = 'echo DO_NOT_EXECUTE > p';
  tmux('send-keys', '-t', firstPane, '-l', draft);
  const preserved = () => { assert.equal(tmux('display-message', '-p', '-t', firstPane, '#{pane_pid}'), firstPid); assert.ok(tmux('capture-pane', '-p', '-J', '-t', firstPane).includes('DO_NOT_EXECUTE')); assert.ok(!fs.existsSync(path.join(dir,'p'))); assert.equal(tmux('display-message','-p','-t',windows[27],'#{pane_pid}'),runningJobPid,'active sleep job survives hide/restore/reconnect'); };

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
