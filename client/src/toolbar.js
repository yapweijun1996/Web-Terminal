(() => {
    const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
    const applySystemTheme = () => { document.documentElement.dataset.theme = systemTheme?.matches === false ? 'light' : 'dark'; };
    systemTheme?.addEventListener('change', applySystemTheme);
    applySystemTheme();
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
    const workspaceStatus = document.createElement('div');
    workspaceStatus.id = 'workspace-status';
    workspaceStatus.setAttribute('role', 'region');
    workspaceStatus.setAttribute('aria-label', 'Workspace status');
    workspaceStatus.tabIndex = 0;
    workspaceStatus.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            workspaceStatus.scrollLeft += event.key === 'ArrowRight' ? 80 : -80;
        } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            workspaceStatus.scrollLeft = event.key === 'Home' ? 0 : workspaceStatus.scrollWidth;
        }
    });
    const indicators = {};
    for (const key of ['connection', 'session', 'input', 'sharing']) {
        const node = document.createElement('span');
        node.id = `status-${key}`;
        node.className = 'workspace-status-item';
        node.setAttribute('role', 'status');
        node.setAttribute('aria-live', 'polite');
        workspaceStatus.append(node);
        indicators[key] = node;
    }
    let connectionState = window.webTerminalConnectionState || 'connecting', activeWindow = null;
    function renderWorkspaceStatus() {
        const connection = connectionState === 'offline' ? 'disconnected'
            : connectionState === 'auth-required' ? 'auth-expired' : connectionState;
        const model = window.TerminalStatus.deriveStatus({ connection, session: activeWindow });
        for (const [key, item] of Object.entries(model)) {
            const node = indicators[key];
            const label = key[0].toUpperCase() + key.slice(1);
            node.dataset.level = item.level;
            node.textContent = `${item.icon} ${label}: ${item.label}`;
            if (key === 'session' && activeWindow) {
                const process = document.createElement('span');
                process.className = 'workspace-status-process';
                process.textContent = ` · ${item.detail.replace(/\. Task health unknown\.$/, '')}`;
                node.append(process);
            }
            node.title = item.detail;
            node.setAttribute('aria-label', `${label}: ${item.label}. ${item.detail}`);
        }
    }
    function layoutWorkspaceStatus() {
        const height = `${workspaceStatus.getBoundingClientRect().height}px`;
        if (document.documentElement.style.getPropertyValue('--workspace-status-height') !== height) {
            document.documentElement.style.setProperty('--workspace-status-height', height);
            window.term?.fit();
        }
    }
    window.addEventListener('web-terminal-active-window', e => {
        activeWindow = e.detail;
        renderWorkspaceStatus();
    });
    window.addEventListener('web-terminal-connection', e => {
        connectionState = e.detail;
        if (e.detail !== 'connected') activeWindow = null;
        renderWorkspaceStatus();
    });
    renderWorkspaceStatus();
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
        status.hidden = state === 'connected';
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
    bar.after(workspaceStatus);
    if (typeof ResizeObserver === 'function') new ResizeObserver(layoutWorkspaceStatus).observe(workspaceStatus);
    addEventListener('resize', layoutWorkspaceStatus);
    layoutWorkspaceStatus();
    const mobileKeys = window.createMobileKeys({
        getTerminal: () => window.mbaTerminalReady?.() && window.webTerminalTarget ? window.term : null,
        getTargetKey: () => {
            const target = window.mbaTerminalReady?.() && window.webTerminalTarget;
            return target ? [target.session, target.sessionId, target.pane, target.serverPid].join('|') : null;
        },
        onLayout: () => requestAnimationFrame(() => {
            document.documentElement.style.setProperty('--mobile-keys-height', `${mobileKeys.panel.getBoundingClientRect().height}px`);
            window.term?.fit();
        }),
    });
    bar.insertBefore(mobileKeys.toggle, bar.children[1]);
    bar.after(mobileKeys.panel);
    window.addEventListener('web-terminal-connection', e => { if (e.detail !== 'connected') mobileKeys.reset(); });
    window.addEventListener('web-terminal-target', mobileKeys.resetIfTargetChanged);
    addEventListener('resize', () => requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--mobile-keys-height', `${mobileKeys.panel.getBoundingClientRect().height}px`);
        window.term?.fit();
    }));
    if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => {
            const height = `${mobileKeys.panel.getBoundingClientRect().height}px`;
            if (document.documentElement.style.getPropertyValue('--mobile-keys-height') !== height) {
                document.documentElement.style.setProperty('--mobile-keys-height', height);
                window.term?.fit();
            }
        }).observe(mobileKeys.panel);
    }
    const displayControls = window.createTerminalDisplayControls({
        getTerminal: () => window.mbaTerminalReady?.() ? window.term : null,
        fit: term => term.fit(),
    });
    bar.insertBefore(displayControls.element, bar.children[1]);
    window.addEventListener('web-terminal-connection', e => { if (e.detail === 'connected') displayControls.apply(); });
    displayControls.apply();
    const keyboardReturn = bar.querySelector('button[data-key="c"]');
    keyboardReturn.setAttribute('aria-keyshortcuts', 'Control+Alt+Shift+T');
    keyboardReturn.title = 'Press Control+Alt+Shift+T in the terminal to focus this toolbar.';
    function labelTerminalInput() {
        window.term?.textarea?.setAttribute('aria-label', 'Terminal input. Press Control Alt Shift T to focus toolbar.');
    }
    window.addEventListener('web-terminal-connection', e => { if (e.detail === 'connected') labelTerminalInput(); });
    labelTerminalInput();
    window.addEventListener('keydown', e => {
        if (e.code !== 'KeyT' || !e.altKey || !e.shiftKey || !e.ctrlKey || e.metaKey || document.activeElement !== window.term?.textarea) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        keyboardReturn.focus();
    }, true);
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
