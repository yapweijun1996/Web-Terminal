'use strict';
// Opt-in, disposable signed-owner Chromium verification. No live browser,
// production session, or production authorization token is used.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createFixture, sleep } = require('./collaboration-fixture');

(async () => {
  const fixture = await createFixture({ realGateway: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { 'CF-Access-Jwt-Assertion': fixture.jwt } });
    const page = await context.newPage();
    await page.goto(fixture.url);
    const pause = page.getByRole('button', { name: 'Pause AI', exact: true });
    const resume = page.getByRole('button', { name: 'Resume sharing', exact: true });
    const error = page.locator('.collaboration-error');
    await pause.waitFor({ state: 'visible' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'Pause AI')?.disabled === false);
    await pause.click();
    await page.getByText('AI paused manually', { exact: true }).waitFor();

    let reply = { status: 401, body: { error: 'Owner authorization unavailable' } };
    await page.route('**/api/collaboration/control', async route => {
      await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
    });
    const scenarios = [
      { status: 401, body: { error: 'Owner authorization unavailable' }, expected: /HTTP 401: Owner authentication failed/ },
      { status: 403, body: { error: 'Forbidden' }, expected: /HTTP 403: Origin\/CSRF request verification failed/ },
      { status: 409, body: { code: 'STALE_TARGET', error: 'Session binding changed' }, expected: /HTTP 409: Session Binding Failure/ },
    ];
    for (const scenario of scenarios) {
      reply = scenario;
      await resume.click();
      await error.waitFor({ state: 'visible' });
      assert.match(await error.innerText(), scenario.expected);
      await page.waitForTimeout(2200); // allow real 2-second authoritative poll
      assert.match(await error.innerText(), scenario.expected, 'poll must not erase the action failure');
      assert.equal(await resume.isEnabled(), true, 'failure must not disable deliberate retry');
    }
    // On narrow screens the controls move inside a collapsible menu. The
    // failure alert must remain visible even after that menu is closed.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector('#toolbar-menu-panel').contains(document.querySelector('#view-actions')));
    await page.locator('#toolbar-menu').evaluate(menu => { menu.open = false; });
    assert.equal(await error.isVisible(), true, 'mobile failure must remain visible outside the closed actions menu');
    assert.match(await error.innerText(), /HTTP 409: Session Binding Failure/);
    const viewport = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(viewport.content <= viewport.width, 'mobile error must not overflow viewport');
    await page.locator('#toolbar-menu > summary').click();
    await resume.waitFor({ state: 'visible' });
    await page.unroute('**/api/collaboration/control');
    await resume.click();
    let shared = false;
    for (let i = 0; i < 80; i++) {
      shared = (await fixture.request('GET', '/api/collaboration/state')).data?.sessions?.shared?.state === 'sharing';
      if (shared) break;
      await sleep(25);
    }
    assert.equal(shared, true, 'the real coordinator must confirm success even when mobile menu closes');
    assert.equal(await error.isHidden(), true, 'successful action clears the failure alert');
    console.log(JSON.stringify({ case: 'signed-owner-browser-persistent-diagnostics', errors: ['401', '403', '409_STALE_TARGET'], pollPersistence: 'PASS', mobileClosedMenuVisibility: 'PASS', successClearsError: 'PASS' }));
    await context.close();
  } finally { await browser.close(); await fixture.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
