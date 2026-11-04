(() => {
    const bar = document.createElement('nav');
    bar.id = 'remote-toolbar';
    bar.setAttribute('aria-label', 'Terminal windows');
    bar.innerHTML =
        '<span>Terminal</span><button class="primary" type="button" data-key="c">+ New tab</button><button type="button" data-key="p">Previous</button><button type="button" data-key="n">Next</button>';
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
