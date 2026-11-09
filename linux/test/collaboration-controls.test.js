'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sessionA = 'web-f394af8c277f';
const sessionB = 'web-012345abcdef';
function fixture() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.textContent = ''; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    append(...items) { this.children.push(...items); }
    click() { if (!this.disabled) return this.listeners.click?.(); }
  }
  let session = sessionA, postResponse = { status: 200, json: { state: 'sharing', serverPid: '123', sessionId: '$1' } };
  let getError = null;
  const state = new Map([
    [sessionA, { state: 'paused', serverPid: '123', sessionId: '$1', idleRemainingMs: null }],
    [sessionB, { state: 'paused', serverPid: '123', sessionId: '$2', idleRemainingMs: null }],
  ]);
  let poll, pendingGet = null;
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/collaboration/state') {
      if (pendingGet) { const wait = pendingGet; pendingGet = null; await wait; }
      if (getError) return { ok: false, status: getError };
      return { ok: true, status: 200, json: async () => ({ sessions: Object.fromEntries(state) }) };
    }
    if (postResponse.reject) throw Error('Do not disclose authorization token from a thrown error');
    return { ok: postResponse.status >= 200 && postResponse.status < 300,
      status: postResponse.status, type: postResponse.type, redirected: postResponse.redirected || false,
      json: async () => postResponse.json };
  };
  const document = { hidden: false, createElement: tag => new Element(tag) };
  const window = { addEventListener() {} };
  const context = vm.createContext({ document, window, fetch, setInterval: callback => { poll = callback; return 1; }, clearInterval() {} });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../ui/collaboration-controls.js'), 'utf8'), context);
  const controls = window.createCollaborationControls({ getSession: () => session, getToken: () => 'fixture-csrf-token' });
  const [status, pause, takeover, resume] = controls.element.children;
  const error = controls.notice;
  return {
    controls, status, error, pause, takeover, resume, requests,
    setResponse(value) { postResponse = value; },
    setSession(value) { session = value; },
    setGetError(value) { getError = value; },
    tick: () => poll(),
    updateState: (name, value) => state.set(name, value),
    delayGet() { let release; pendingGet = new Promise(resolve => { release = resolve; }); return release; },
  };
}

test('HTTP errors distinguish Owner Auth, Origin/CSRF, stale Session Binding and input busy', async () => {
  const f = fixture(); await f.controls.refresh();
  const cases = [
    [{ status: 401, json: { error: 'Owner authorization unavailable' } }, /HTTP 401: Owner authentication failed/],
    [{ status: 403, json: { error: 'Forbidden' } }, /HTTP 403: Origin\/CSRF request verification failed/],
    [{ status: 409, json: { error: 'Session binding changed', code: 'STALE_TARGET' } }, /HTTP 409: Session Binding Failure/],
    [{ status: 409, json: { error: 'Input control changed or busy' } }, /HTTP 409: input control changed or is busy/],
    [{ status: 503, json: { error: 'Input outcome uncertain' } }, /HTTP 503: operation outcome uncertain/],
    [{ status: 500, json: { error: 'Internal service error' } }, /HTTP 500: request unsuccessful/],
    [{ status: 0, type: 'opaqueredirect', json: null }, /HTTP status unavailable: sign-in redirect/],
  ];
  for (const [response, expected] of cases) {
    f.setResponse(response);
    await f.resume.click();
    assert.equal(f.error.hidden, false);
    assert.match(f.error.textContent, expected);
    assert.equal(f.resume.disabled, false, 'failure permits deliberate retry');
    assert.equal(f.status.textContent, 'Owner control');
    await f.tick(); await f.tick();
    assert.match(f.error.textContent, expected, 'two-second polls must not erase error');
  }
  assert.equal(f.requests.filter(r => r.method === 'POST').length, cases.length, 'no automatic retry');
  assert.equal(f.error.attributes.role, 'alert', 'failure has accessible alert semantics');
});

test('error survives failed state polling but is cleared on successful action or session change', async () => {
  const f = fixture(); await f.controls.refresh();
  f.setResponse({ status: 401, json: { error: 'Owner authorization unavailable' } });
  await f.resume.click();
  f.setGetError(401); await f.tick();
  assert.equal(f.error.hidden, false, 'failed polling also cannot hide the last action failure');
  f.setGetError(null);
  f.setResponse({ status: 200, json: { state: 'sharing', serverPid: '123', sessionId: '$1' } });
  await f.controls.refresh(); await f.resume.click();
  assert.equal(f.error.hidden, true, 'successful action clears the error');
  assert.equal(f.status.textContent, 'AI sharing enabled');
  f.updateState(sessionA, { state: 'paused', serverPid: '123', sessionId: '$1' });
  await f.controls.refresh();
  f.setResponse({ status: 403, json: { error: 'Forbidden' } }); await f.resume.click();
  f.setSession(sessionB); await f.controls.refresh();
  assert.equal(f.error.hidden, true, 'a new session must not inherit an old error');
  await f.resume.click();
  assert.equal(f.requests.filter(r => r.method === 'POST').at(-1).body.sessionId, '$2', 'new session must use its own binding');
});

test('late state GET cannot overwrite an action result and response bodies are never displayed', async () => {
  const f = fixture(); await f.controls.refresh();
  const release = f.delayGet();
  const oldRefresh = f.controls.refresh();
  f.setResponse({ status: 409, json: { code: 'STALE_TARGET', error: 'PRIVATE_TOKEN_MUST_NOT_DISPLAY' } });
  await f.resume.click(); release(); await oldRefresh;
  assert.match(f.error.textContent, /Session Binding Failure/);
  assert.doesNotMatch(f.error.textContent, /PRIVATE_TOKEN/);
  assert.equal(f.status.textContent, 'Owner control');
  f.setResponse({ reject: true }); await f.resume.click();
  assert.match(f.error.textContent, /network or invalid response/);
  assert.doesNotMatch(f.error.textContent, /authorization token/);
});
