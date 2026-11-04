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
        status.title = 'Check the active window after reconnecting; background job status is unknown.';
        status.setAttribute('aria-label', `${status.textContent}. Check the active window after reconnecting. Background job status is unknown.`);
        retry.hidden = state !== 'offline' && state !== 'auth-required';
    }
    retry.addEventListener('click', () => {
        if (typeof window.webTerminalRetry !== 'function') return;
        status.focus();
        window.webTerminalRetry();
    });
    bar.insertBefore(status, bar.children[1]);
    bar.insertBefore(retry, bar.children[2]);
    window.addEventListener('web-terminal-connection', e => showConnection(e.detail));
    showConnection(window.webTerminalConnectionState || 'connecting');
    document.body.prepend(bar);
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
    });
    window.dispatchEvent(new Event('resize'));
})();
