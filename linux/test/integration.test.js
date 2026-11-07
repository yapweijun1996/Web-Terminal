'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('private Linux fixture isolates sessions and preserves jobs', async () => {
  assert.equal(spawnSync('tmux', ['-V']).status, 0, 'tmux is required');
  assert.equal(spawnSync('/usr/bin/ttyd', ['--version']).status, 0, 'ttyd is required at /usr/bin/ttyd');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fixture-'));
  const socket = path.join(directory, 'ui.sock');
  const tmuxSocket = `wt-test-${process.pid}-${Date.now()}`;
  const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', '-L', tmuxSocket, ...args], { encoding: 'utf8' }).trim();
  let server;
  const start = () => {
    server = spawn(process.execPath, [path.join(__dirname, '../ui/server.js')], {
      env: { ...process.env, TERMINAL_RUNTIME: directory, TERMINAL_TMUX_SOCKET: tmuxSocket, TERMINAL_TEST_HTTP: '1', TERMINAL_UPLOAD_DIR: path.join(directory, 'uploads') },
      stdio: 'ignore',
    });
  };
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error('fixture server exited');
      if (fs.existsSync(socket)) return;
      await sleep(50);
    }
    throw new Error('fixture socket did not appear');
  };
  const request = (method, url, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path: url, headers: { host: 'fixture.test', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const upgrade = origin => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: '/terminal/shared/ws', headers: {
      host: 'fixture.test', origin, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-protocol': 'tty',
    } });
    req.once('upgrade', (res, stream) => { stream.destroy(); resolve(res.statusCode); });
    req.once('response', res => { res.resume(); resolve(res.statusCode); });
    req.once('error', err => err.code === 'ECONNRESET' ? resolve('rejected') : reject(err));
    req.end();
  });

  try {
    tmux('new-session', '-d', '-s', 'shared');
    start();
    await ready();
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    const index = await request('GET', '/');
    assert.equal(index.status, 200);

    const list = JSON.parse((await request('GET', '/api/sessions')).body);
    assert.deepEqual(list.sessions, ['shared']);
    assert.deepEqual(Object.keys(list.details), ['shared']);
    assert.deepEqual(Object.keys(list.details.shared), ['command']);
    assert.match(list.details.shared.command, /^[A-Za-z0-9._+-]{0,24}$/);
    assert.match(list.token, /^[a-f0-9]{64}$/);
    const headers = { origin: 'http://fixture.test', 'content-type': 'application/json', 'x-terminal-request': list.token };
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=', 'base64');
    const imageHeaders = { ...headers, 'content-type': 'application/octet-stream', 'content-length': image.length };
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, origin: 'http://other.test' }, image)).status, 403);
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, 'x-terminal-request': 'invalid' }, image)).status, 403);
    assert.equal((await request('POST', '/api/images', imageHeaders, image)).status, 409, 'uploads require a recovery receipt');
    assert.equal((await request('POST', '/api/images/prepare', { ...headers, origin: 'http://other.test' })).status, 403);
    const invalidReceipt = JSON.parse((await request('POST', '/api/images/prepare', headers)).body);
    assert.equal((await request('POST', '/api/images', { ...imageHeaders, 'x-image-receipt': invalidReceipt.ticket, 'content-length': 4 }, Buffer.from('nope'))).status, 415);
    assert.equal(JSON.parse((await request('POST', '/api/images/result', { ...headers, 'x-image-receipt': invalidReceipt.ticket })).body).state, 'failed');
    const receipt = JSON.parse((await request('POST', '/api/images/prepare', headers)).body);
    assert.equal(receipt.target, null, 'missing target metadata must fail closed');
    const uploaded = await request('POST', '/api/images', { ...imageHeaders, 'x-image-receipt': receipt.ticket }, image);
    assert.equal(uploaded.status, 201);
    const uploadedPath = JSON.parse(uploaded.body).path;
    assert.equal(path.dirname(uploadedPath), path.join(directory, 'uploads'));
    assert.equal(fs.statSync(uploadedPath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(uploadedPath), image);
    const recovered = await request('POST', '/api/images/result', { ...headers, 'x-image-receipt': receipt.ticket });
    assert.equal(JSON.parse(recovered.body).path, uploadedPath);
    assert.equal((await request('POST', '/api/images/insert', { ...headers, 'x-image-receipt': receipt.ticket })).status, 409);
    const interrupted = JSON.parse((await request('POST', '/api/images/prepare', headers)).body);
    const partial = http.request({ socketPath: socket, method: 'POST', path: '/api/images', headers: { host: 'fixture.test', ...imageHeaders, 'content-length': 100, 'x-image-receipt': interrupted.ticket } });
    partial.on('error', () => {}); partial.write(image.subarray(0, 8));
    let interruptedState;
    for (let i = 0; i < 100; i++) {
      interruptedState = JSON.parse((await request('POST', '/api/images/result', { ...headers, 'x-image-receipt': interrupted.ticket })).body).state;
      if (interruptedState === 'uploading') break;
      await sleep(10);
    }
    assert.equal(interruptedState, 'uploading');
    partial.destroy();
    for (let i = 0; i < 100; i++) {
      interruptedState = JSON.parse((await request('POST', '/api/images/result', { ...headers, 'x-image-receipt': interrupted.ticket })).body).state;
      if (interruptedState === 'failed') break;
      await sleep(10);
    }
    assert.equal(interruptedState, 'failed', 'an interrupted request is recorded as not saved');
    assert.equal((await request('POST', '/api/sessions', { ...headers, origin: 'http://other.test' })).status, 403);
    assert.equal((await request('POST', '/api/sessions', { ...headers, 'x-terminal-request': 'invalid' })).status, 403);
    const created = await request('POST', '/api/sessions', headers);
    assert.equal(created.status, 201);
    const name = JSON.parse(created.body).name;
    assert.match(name, /^web-[a-f0-9]{12}$/);
    assert.equal(tmux('show-environment', '-t', name, 'PI_CLIPBOARD_OSC52'), 'PI_CLIPBOARD_OSC52=1');
    assert.equal(tmux('show-options', '-s', '-v', 'set-clipboard'), 'external');
    assert.equal((await request('GET', '/terminal/invalid')).status, 404);
    const terminalPage = await request('GET', '/terminal/shared');
    assert.equal(terminalPage.status, 200);
    assert.equal(tmux('show-options', '-s', '-v', 'set-clipboard'), 'on');
    tmux('set-option', '-u', '-t', 'shared', 'set-titles');
    assert.equal((await request('GET', '/terminal/shared')).status, 200);
    assert.equal(tmux('show-options', '-t', 'shared', 'set-titles'), 'set-titles on', 'reusing ttyd restores session metadata settings');
    assert.match(terminalPage.body, /src="\/clipboard-bridge\.js"/);
    assert.equal((await request('GET', '/clipboard-bridge.js')).status, 200);
    assert.equal((await request('GET', '/mobile-keys.js')).status, 200);
    assert.equal((await request('GET', '/mobile-keys.css')).status, 200);
    assert.equal((await request('GET', '/display-controls.js')).status, 200);
    assert.equal((await request('GET', '/display-controls.css')).status, 200);
    assert.equal((await request('GET', '/sidebar.js')).status, 200);
    assert.equal((await request('GET', '/sidebar.css')).status, 200);
    const targetInfo = tmux('display-message', '-p', '-t', 'shared:', '#{session_id}|#{pane_id}|#{pid}').split('|');
    const targetHeaders = { ...headers, 'x-terminal-session': 'shared', 'x-terminal-session-id': targetInfo[0], 'x-terminal-pane': targetInfo[1], 'x-terminal-server-pid': targetInfo[2] };
    const mismatch = JSON.parse((await request('POST', '/api/images/prepare', { ...targetHeaders, 'x-terminal-session-id': '$999999' })).body);
    assert.equal(mismatch.target, null, 'metadata from another session cannot select a pane');
    const bound = JSON.parse((await request('POST', '/api/images/prepare', targetHeaders)).body);
    assert.ok(bound.target, 'a valid pane in the requested session is captured');
    const boundUpload = JSON.parse((await request('POST', '/api/images', { ...imageHeaders, 'x-image-receipt': bound.ticket }, image)).body);
    const shellCommand = tmux('display-message', '-p', '-t', targetInfo[1], '#{pane_current_command}');
    const otherPane = tmux('split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', 'shared:', 'sleep 60');
    tmux('select-pane', '-t', otherPane);
    let activeCommand;
    for (let i = 0; i < 100; i++) {
      activeCommand = JSON.parse((await request('GET', '/api/sessions')).body).details.shared.command;
      if (activeCommand === 'sleep') break;
      await sleep(20);
    }
    assert.equal(activeCommand, 'sleep', 'session details follow the active pane foreground command without arguments');
    tmux('select-pane', '-t', targetInfo[1]);
    const expectedShellCommand = path.basename(shellCommand).replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 24);
    for (let i = 0; i < 100; i++) {
      activeCommand = JSON.parse((await request('GET', '/api/sessions')).body).details.shared.command;
      if (activeCommand === expectedShellCommand) break;
      await sleep(20);
    }
    assert.equal(activeCommand, expectedShellCommand,
      'selecting another pane updates the command rather than retaining the inactive sleep');
    tmux('select-pane', '-t', otherPane);
    assert.equal((await request('POST', '/api/images/insert', { ...headers, 'x-image-receipt': bound.ticket })).status, 200);
    let oldPaneOutput = '';
    for (let i = 0; i < 100; i++) {
      oldPaneOutput = tmux('capture-pane', '-J', '-p', '-t', targetInfo[1]);
      if (oldPaneOutput.replace(/\n/g, '').includes(boundUpload.path)) break;
      await sleep(10);
    }
    assert.ok(oldPaneOutput.replace(/\n/g, '').endsWith(boundUpload.path), 'the captured pane receives the path without Enter');
    assert.ok(!tmux('capture-pane', '-J', '-p', '-t', otherPane).includes(boundUpload.path), 'the later pane does not receive it');
    assert.equal((await request('POST', '/api/images/insert', { ...headers, 'x-image-receipt': bound.ticket })).status, 409, 'insertion cannot be repeated');
    assert.equal((await request('POST', '/api/sessions/shared/latest', { ...targetHeaders, 'x-terminal-pane': '%999999' }, '{}')).status, 409);
    assert.equal((await request('POST', '/api/sessions/shared/latest', targetHeaders, '{}')).status, 200);
    assert.equal(tmux('capture-pane', '-J', '-p', '-t', targetInfo[1]), oldPaneOutput, 'returning to live outside copy mode does not touch the draft');
    tmux('copy-mode', '-t', targetInfo[1]);
    assert.match(tmux('display-message', '-p', '-t', targetInfo[1], '#{pane_mode}'), /^copy-mode/);
    assert.equal((await request('POST', '/api/sessions/shared/latest', targetHeaders, '{}')).status, 200);
    assert.equal(tmux('display-message', '-p', '-t', targetInfo[1], '#{pane_mode}'), '');
    assert.equal(tmux('capture-pane', '-J', '-p', '-t', targetInfo[1]), oldPaneOutput, 'leaving copy mode preserves the draft');
    const lostHeaders = { ...targetHeaders, 'x-terminal-pane': otherPane };
    const lost = JSON.parse((await request('POST', '/api/images/prepare', lostHeaders)).body);
    const lostUpload = JSON.parse((await request('POST', '/api/images', { ...imageHeaders, 'x-image-receipt': lost.ticket }, image)).body);
    tmux('kill-pane', '-t', otherPane);
    assert.equal((await request('POST', '/api/images/insert', { ...headers, 'x-image-receipt': lost.ticket })).status, 409);
    assert.equal(JSON.parse((await request('POST', '/api/images/result', { ...headers, 'x-image-receipt': lost.ticket })).body).path, lostUpload.path);
    const shim = terminalPage.body.match(/<head><script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(shim, 'the ttyd page must include the connection-state shim');
    const handlers = {}, messages = [], timers = [];
    let onTitle, focusCalls = 0;
    const overlay = { childNodes: [{ nodeType: 3 }], textContent: 'Press ⏎ to Reconnect' };
    overlay.firstChild = overlay.childNodes[0];
    const unrelated = { childNodes: [{ nodeType: 1 }, { nodeType: 1 }], textContent: 'Press ⏎ to Reconnect' };
    const window = {
      WebSocket: class { addEventListener(name, callback) { handlers[name] = callback; } },
      term: { options: { disableStdin: false }, onTitleChange: callback => { onTitle = callback; }, focus: () => { focusCalls++; } },
      frameElement: { dataset: { preserveTabFocus: 'true' } },
      parent: { document: { activeElement: {} }, postMessage: (message, target) => messages.push({ state: message.state, target }) },
      location: { origin: 'http://fixture.test' },
    };
    const document = { querySelectorAll: () => [overlay, unrelated], title: '' };
    vm.runInNewContext(shim, { window, document, Node: { TEXT_NODE: 3 }, setTimeout: fn => timers.push(fn) });
    document.title = 'synthetic command or path';
    assert.equal(document.title, 'Terminal view', 'ttyd must not publish its launch command in the frame title');
    const restrictedDocument = { querySelectorAll: () => [] };
    Object.defineProperty(restrictedDocument, 'title', { value: 'fixed', configurable: false });
    const fallbackWindow = { WebSocket: class { addEventListener() {} }, parent: { postMessage() {} }, location: { origin: 'http://fixture.test' } };
    vm.runInNewContext(shim, { window: fallbackWindow, document: restrictedDocument, Node: { TEXT_NODE: 3 }, setTimeout() {} });
    assert.doesNotThrow(() => new fallbackWindow.WebSocket('ws://fixture.test'), 'a rejected title override must not prevent connections');
    new window.WebSocket('ws://fixture.test');
    window.term.focus();
    assert.equal(focusCalls, 0, 'the first terminal autofocus must not steal keyboard navigation focus');
    window.term.focus();
    assert.equal(focusCalls, 1, 'subsequent explicit terminal focus still works');
    assert.equal(window.term.options.disableStdin, true);
    assert.equal(messages.at(-1).state, 'Connecting');
    handlers.open();
    assert.equal(window.term.options.disableStdin, false);
    assert.equal(messages.at(-1).state, 'Connected');
    onTitle('__WEB_TERMINAL_TARGET__|shared|$0|%3|42|copy-mode|fixture');
    assert.equal(document.title, 'Terminal view', 'terminal metadata must not become the accessible frame title');
    assert.equal(window.webTerminalTarget.pane, '%3');
    assert.equal(window.webTerminalTarget.session, 'shared');
    onTitle('unverified title');
    assert.equal(window.webTerminalTarget, null, 'unverified title metadata fails closed');
    onTitle('__WEB_TERMINAL_TARGET__|shared|$0|%3|42|copy-mode|fixture');
    handlers.close();
    assert.equal(window.term.options.disableStdin, true);
    assert.equal(window.webTerminalTarget, null, 'disconnect clears the target');
    assert.equal(messages.at(-1).state, 'Disconnected');
    assert.ok(messages.every(message => message.target === 'http://fixture.test'));
    timers.forEach(fn => fn());
    assert.equal(overlay.textContent, 'Use Retry in the toolbar');
    assert.equal(unrelated.textContent, 'Press ⏎ to Reconnect');
    window.parent.document.activeElement = window.frameElement;
    new window.WebSocket('ws://fixture.test');
    window.term.focus();
    assert.equal(focusCalls, 2, 'a terminal the user already focused may keep focus');
    assert.equal(await upgrade('http://other.test'), 'rejected');
    assert.equal(await upgrade('http://fixture.test'), 101);

    tmux('send-keys', '-t', name, 'sleep 60', 'Enter');
    let command = '';
    for (let i = 0; i < 30 && command !== 'sleep'; i++) {
      await sleep(50);
      command = tmux('display-message', '-p', '-t', name, '#{pane_current_command}');
    }
    assert.equal(command, 'sleep');
    let runningList;
    for (let i = 0; i < 100; i++) {
      runningList = JSON.parse((await request('GET', '/api/sessions')).body);
      if (runningList.details[name]?.command === 'sleep') break;
      await sleep(20);
    }
    assert.deepEqual(runningList.sessions, ['shared', name].sort());
    assert.deepEqual(Object.keys(runningList.details).sort(), runningList.sessions);
    assert.deepEqual(runningList.details[name], { command: 'sleep' });
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    start();
    await ready();
    assert.equal(tmux('display-message', '-p', '-t', name, '#{pane_current_command}'), 'sleep');
    assert.ok(JSON.parse((await request('GET', '/api/sessions')).body).sessions.includes(name));
    const currentList = JSON.parse((await request('GET', '/api/sessions')).body);
    assert.deepEqual(currentList.details[name], { command: 'sleep' }, 'UI restart preserves and reports the foreground job');
    const closeHeaders = { origin: 'http://fixture.test', 'content-type': 'application/json', 'x-terminal-request': currentList.token };
    const identity = JSON.parse((await request('GET', `/api/sessions/${name}/identity`)).body);
    const target = { ...closeHeaders, 'x-terminal-session-id': identity.sessionId, 'x-terminal-server-pid': identity.serverPid };
    assert.equal((await request('POST', `/api/sessions/${name}/close`, { ...target, origin: 'http://other.test' })).status, 403);
    assert.equal((await request('POST', `/api/sessions/${name}/close`, { ...target, 'x-terminal-request': 'invalid' })).status, 403);
    assert.equal((await request('POST', `/api/sessions/${name}/close`, { ...target, 'x-terminal-server-pid': '999999999' })).status, 409);
    assert.equal(tmux('display-message', '-p', '-t', name, '#{pane_current_command}'), 'sleep');
    tmux('kill-session', '-t', `=${name}`);
    tmux('new-session', '-d', '-s', name);
    assert.equal((await request('POST', `/api/sessions/${name}/close`, target)).status, 409, 'a replacement session is not ended by an old confirmation');
    const replacement = JSON.parse((await request('GET', `/api/sessions/${name}/identity`)).body);
    assert.equal((await request('GET', `/terminal/${name}`)).status, 200);
    const childPids = fs.readFileSync(`/proc/${server.pid}/task/${server.pid}/children`, 'utf8').trim().split(/\s+/).map(Number);
    const childPid = childPids.find(pid => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`ttyd-${name}.sock`); } catch { return false; }
    });
    assert.ok(childPid > 0, 'the session has its own UI-managed ttyd');
    assert.equal((await request('POST', `/api/sessions/${name}/close`, { ...target, 'x-terminal-session-id': replacement.sessionId, 'x-terminal-server-pid': replacement.serverPid })).status, 200);
    for (let i = 0; i < 100 && fs.existsSync(`/proc/${childPid}`); i++) await sleep(10);
    assert.equal(fs.existsSync(`/proc/${childPid}`), false, 'ending the session also stops its ttyd');
    const remainingList = JSON.parse((await request('GET', '/api/sessions')).body);
    assert.ok(!remainingList.sessions.includes(name));
    assert.equal(Object.hasOwn(remainingList.details, name), false, 'closed sessions leave no stale command details');
    assert.ok(remainingList.sessions.includes('shared'), 'another session is preserved');
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    try { tmux('kill-server'); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
