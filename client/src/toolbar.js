(() => {
    const bar = document.createElement('nav');
    bar.id = 'remote-toolbar';
    bar.setAttribute('aria-label', 'Terminal windows');
    bar.innerHTML =
        '<span>Terminal</span><button class="primary" type="button" data-key="c">+ New tab</button><button type="button" data-key="p">Previous</button><button type="button" data-key="n">Next</button>';
    const status = document.createElement('span');
    status.id = 'connection-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.tabIndex = -1;
    const activeTarget = document.createElement('span');
    activeTarget.id = 'active-target';
    activeTarget.setAttribute('role', 'status');
    activeTarget.setAttribute('aria-live', 'polite');
    const scrollStatus = document.createElement('span');
    scrollStatus.id = 'scroll-status';
    scrollStatus.setAttribute('role', 'status');
    scrollStatus.setAttribute('aria-live', 'polite');
    const latest = document.createElement('button');
    latest.id = 'scroll-latest';
    latest.type = 'button';
    latest.textContent = 'Return to live';
    latest.title = 'Exit tmux copy mode; an application may control its own scroll.';
    const scrollNotice = document.createElement('span');
    scrollNotice.id = 'scroll-notice';
    scrollNotice.setAttribute('role', 'status');
    scrollNotice.setAttribute('aria-live', 'polite');
    const diagnostics = document.createElement('details');
    diagnostics.id = 'terminal-diagnostics';
    diagnostics.innerHTML = '<summary>Details</summary><section aria-label="Terminal status details"><p><strong>View:</strong> <span data-view>Unknown</span></p><p><strong>Terminal connection:</strong> <span data-link>Unknown</span></p><p><strong>End-to-end input and output:</strong> Not checked</p><p><strong>Individual components:</strong> Not checked</p><p><strong>Background task:</strong> Unknown</p><p><strong>Access authorization:</strong> Not checked</p><p>After reconnecting, check the active window. Use Retry if offered.</p></section>';
    const detailView = diagnostics.querySelector('[data-view]');
    const detailLink = diagnostics.querySelector('[data-link]');
    let returning = false;
    function showTarget(target) {
        activeTarget.textContent = target ? `Window ${target.windowIndex}, pane ${target.paneIndex}` : 'Window unknown';
        detailView.textContent = target ? `Window ${target.windowIndex}, pane ${target.paneIndex}` : 'Unknown';
        activeTarget.title = 'The last tmux-confirmed window and pane.';
        const state = !target ? 'tmux scroll unknown' : /^copy-mode/.test(target.paneMode) ? 'tmux scrollback' : target.paneMode ? 'tmux mode unknown' : 'tmux live';
        scrollStatus.textContent = `${state}; app scroll unknown`;
        scrollStatus.title = 'This reports tmux mode only; application scroll position is unknown.';
        scrollStatus.setAttribute('aria-label', `${state}. Application scroll position is unknown.`);
        latest.disabled = returning || !target;
    }
    const retry = document.createElement('button');
    retry.id = 'connection-retry';
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.hidden = true;
    const labels = {
        connecting: 'Connecting',
        connected: 'Connected — check window',
        reconnecting: 'Reconnecting (input paused)',
        offline: 'Offline (input paused)',
        'auth-required': 'Sign-in may be required',
    };
    function showConnection(state) {
        status.textContent = labels[state] || 'Connection state unknown';
        detailLink.textContent = labels[state] || 'Unknown';
        status.title = 'Check the active window after reconnecting; background job status is unknown.';
        status.setAttribute('aria-label', `${status.textContent}. Check the active window after reconnecting. Background job status is unknown.`);
        retry.hidden = state !== 'offline' && state !== 'auth-required';
    }
    retry.addEventListener('click', () => {
        if (typeof window.webTerminalRetry !== 'function') return;
        status.focus();
        window.webTerminalRetry();
    });
    latest.addEventListener('click', async () => {
        const target = window.webTerminalTarget;
        if (returning || !target || !window.webTerminalViewId || !window.mbaTerminalReady?.()) return;
        returning = true;
        latest.disabled = true;
        scrollNotice.textContent = 'Returning to live…';
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch('/__terminal_upload', {
                method: 'POST', cache: 'no-store', redirect: 'manual', signal: controller.signal,
                headers: {
                    'X-Terminal-Action': 'latest', 'X-Terminal-View': window.webTerminalViewId,
                    'X-Terminal-Session': target.session, 'X-Terminal-Session-Id': target.sessionId,
                    'X-Terminal-Pane': target.pane, 'X-Terminal-Server-Pid': target.serverPid,
                },
            });
            scrollNotice.textContent = response.ok ? 'tmux live requested; app scroll unknown' : 'Unable to change tmux scroll';
        } catch { scrollNotice.textContent = 'Unable to change tmux scroll'; }
        finally { clearTimeout(timeout); returning = false; latest.disabled = !window.webTerminalTarget; }
    });
    bar.insertBefore(status, bar.children[1]);
    bar.insertBefore(retry, bar.children[2]);
    bar.insertBefore(activeTarget, bar.children[3]);
    bar.insertBefore(scrollStatus, bar.children[4]);
    bar.insertBefore(latest, bar.children[5]);
    bar.insertBefore(scrollNotice, bar.children[6]);
    bar.append(diagnostics);
    window.addEventListener('web-terminal-connection', e => showConnection(e.detail));
    window.addEventListener('web-terminal-target', e => {
        scrollNotice.textContent = '';
        showTarget(e.detail);
    });
    showConnection(window.webTerminalConnectionState || 'connecting');
    showTarget(window.webTerminalTarget);
    document.body.prepend(bar);
    const displayControls = window.createTerminalDisplayControls({
        getTerminal: () => window.mbaTerminalReady?.() ? window.term : null,
        fit: term => term.fit(),
    });
    bar.insertBefore(displayControls.element, bar.children[1]);
    window.addEventListener('web-terminal-connection', e => { if (e.detail === 'connected') displayControls.apply(); });
    displayControls.apply();
    bar.addEventListener('click', e => {
        const btn = e.target.closest('button[data-key]');
        if (!btn) return;
        const input = document.querySelector('.xterm-helper-textarea');
        if (!input) return;
        input.focus();
        for (const [key, ctrl] of [
            ['b', true],
            [btn.dataset.key, false],
        ]) {
            const code = key.toUpperCase().charCodeAt(0);
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key,
                    code: 'Key' + key.toUpperCase(),
                    keyCode: code,
                    which: code,
                    ctrlKey: ctrl,
                    bubbles: true,
                    cancelable: true,
                })
            );
        }
        if (e.detail === 0) btn.focus();
    });
    window.dispatchEvent(new Event('resize'));
})();
