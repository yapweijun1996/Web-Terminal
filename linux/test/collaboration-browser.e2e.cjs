'use strict';
// Real browser + signed-owner OAuth fixture; no live grants or terminal sessions.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createFixture, sleep } = require('./collaboration-fixture');
(async () => {
  const fixture = await createFixture({ realGateway: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { 'CF-Access-Jwt-Assertion': fixture.jwt } });
    const page = await context.newPage();
    await page.goto(fixture.url);
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.contentWindow?.term));
    await page.getByRole('button', { name: 'Pause AI', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Pause AI')?.disabled === false);
    const [beforePause] = await fixture.list();
    await page.getByRole('button', { name: 'Pause AI', exact: true }).click();
    await page.getByText('AI paused manually', { exact: true }).waitFor();
    assert.equal((await fixture.mutate('terminal_type', { target: beforePause, text: 'STALE_BROWSER' })).error.code, 'STALE_INPUT_GENERATION');
    await page.getByRole('button', { name: 'Resume sharing', exact: true }).click();
    await page.getByText('AI sharing enabled', { exact: true }).waitFor();
    const [fresh] = await fixture.list();
    assert.deepEqual(await fixture.mutate('terminal_type', { target: fresh, text: 'BROWSER_AI_中文' }), { sent: true, submitted: false });
    assert.deepEqual(await fixture.mutate('terminal_send_key', { target: fresh, key: 'Enter' }), { sent: true, submitted: true });
    const frame = page.frames().find(frame => /\/terminal\/shared\/?$/.test(frame.url()));
    assert.ok(frame, 'actual shared ttyd iframe is attached');
    const beforeReplies = fixture.verifierRequests();
    const cpr = /(?:\x1b|\^\[)\[\d+;\d+R/g, da = /(?:\x1b|\^\[)\[\?[0-9;]+c/g;
    const querySnapshot = fixture.tmux('capture-pane', '-p', '-t', fresh.paneId);
    const beforeCpr = (querySnapshot.match(cpr) || []).length, beforeDa = (querySnapshot.match(da) || []).length;
    const tty = fixture.tmux('list-clients', '-F', '#{client_tty}').trim().split('\n')[0];
    assert.match(tty, /^\/dev\/pts\/\d+$/);
    // Write output into the disposable ttyd client's PTY (tmux consumes queries
    // on an inner pane PTY itself): real xterm must answer
    // both CPR and DA queries without falsely treating the replies as owner input.
    const fd = fs.openSync(tty, 'w');
    try { fs.writeSync(fd, '\x1b[6n\x1b[c'); } finally { fs.closeSync(fd); }
    for (let i = 0; i < 100 && fixture.verifierRequests() < beforeReplies + 2; i++) await sleep(25);
    assert.ok(fixture.verifierRequests() >= beforeReplies + 2, 'protocol traffic traversed owner verification');
    let replied = false;
    for (let i = 0; i < 100; i++) {
      const output = fixture.tmux('capture-pane', '-p', '-t', fresh.paneId);
      replied = (output.match(cpr) || []).length > beforeCpr && (output.match(da) || []).length > beforeDa;
      if (replied) break;
      await sleep(25);
    }
    assert.ok(replied, 'fresh real CPR and DA replies arrived through ttyd and cat, not merely a status poll');
    assert.equal((await fixture.request('GET', '/api/collaboration/state')).data.sessions.shared.state, 'sharing');
    assert.equal((await fixture.list())[0].inputGeneration, fresh.inputGeneration);
    await frame.locator('.xterm-screen').click();
    await page.keyboard.type('BROWSER_HUMAN');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 100 && !fixture.tmux('capture-pane', '-p', '-t', fresh.paneId).includes('BROWSER_HUMAN'); i++) await sleep(50);
    assert.match(fixture.tmux('capture-pane', '-p', '-t', fresh.paneId), /BROWSER_HUMAN/);
    await page.getByText(/Human control · AI resumes in/).waitFor();
    const pending = (await fixture.request('GET', '/api/collaboration/state')).data.sessions.shared;
    assert.ok(pending.idleRemainingMs > 0 && pending.idleRemainingMs <= 10000, 'real browser sees server-side idle countdown');
    await page.getByText('AI sharing enabled', { exact: true }).waitFor({ timeout: 18000 });
    assert.equal((await fixture.mutate('terminal_send_key', { target: fresh, key: 'Enter' })).error.code, 'STALE_INPUT_GENERATION');
    await frame.evaluate(() => window.term.paste('BROWSER_PASTE'));
    await page.getByText(/Human control · AI resumes in/).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Resume sharing')?.disabled === false);
    await page.getByRole('button', { name: 'Resume sharing', exact: true }).click();
    await page.getByText('AI sharing enabled', { exact: true }).waitFor();
    assert.deepEqual(await frame.evaluate(() => ({ input: typeof window.term.input, target: !!window.webTerminalTarget, disabled: window.term.options.disableStdin })), { input: 'function', target: true, disabled: false }, 'real ttyd exposes live mobile input adapter');
    await page.getByRole('button', { name: 'Keys', exact: true }).click();
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await page.getByText(/Human control · AI resumes in/).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Resume sharing')?.disabled === false);
    await page.getByRole('button', { name: 'Resume sharing', exact: true }).click();
    await page.getByText('AI sharing enabled', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByText(/Human control · AI resumes in/).waitFor();
    const artifacts = path.resolve(process.env.COLLABORATION_ARTIFACT_DIR || 'artifacts/collaboration-browser');
    fs.mkdirSync(artifacts, { recursive: true });
    const metrics = [];
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await sleep(250);
      if (!(await page.getByRole('button', { name: 'Resume sharing', exact: true }).isVisible())) await page.locator('#toolbar-menu > summary').click();
      await page.getByRole('button', { name: 'Resume sharing', exact: true }).waitFor({ state: 'visible' });
      const measured = await page.evaluate(() => ({ width: window.innerWidth, documentWidth: document.documentElement.scrollWidth }));
      assert.ok(measured.documentWidth <= measured.width, 'collaboration controls do not overflow viewport');
      await page.screenshot({ path: path.join(artifacts, `collaboration-${viewport.width}.png`), fullPage: true });
      metrics.push({ viewport, ...measured, ownerControlsVisible: true });
    }
    // Disabling the clicked button can move focus and close the menu. Let the
    // browser finish that focus transition, then reopen it through its summary.
    await page.getByRole('button', { name: 'Resume sharing', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!(await page.getByRole('button', { name: 'Pause AI', exact: true }).isVisible())) await page.locator('#toolbar-menu > summary').click();
    await page.getByText('AI sharing enabled', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Pause AI', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (!(await page.getByRole('button', { name: 'Resume sharing', exact: true }).isVisible())) await page.locator('#toolbar-menu > summary').click();
    await page.getByText('AI paused manually', { exact: true }).waitFor();
    fs.writeFileSync(path.join(artifacts, 'metrics.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify({ case: 'signed-owner-real-browser-collaboration', oauthPkce: 'PASS', mcpTextAndEnter: 'PASS', browserKeyboard: 'PASS', pauseResumeTakeover: 'PASS', staleEnter: 'PASS', terminalProtocolReplies: 'PASS', clipboardAndMobileKeys: 'PASS' }));
    await context.close();
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
