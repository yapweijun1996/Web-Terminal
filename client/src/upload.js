(() => {
    const bar = document.querySelector('#remote-toolbar');
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    picker.multiple = false;
    picker.hidden = true;
    const choose = document.createElement('button');
    choose.type = 'button';
    choose.textContent = 'Upload image';
    choose.addEventListener('click', () => picker.click());
    bar.append(choose, picker);
    const status = document.createElement('div');
    status.id = 'upload-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    document.body.append(status);
    const results = document.createElement('section');
    results.id = 'upload-results';
    results.setAttribute('aria-label', 'Saved image paths');
    document.body.append(results);
    let busy = false,
        statusTimer;
    function watchPasteTarget() {
        const terminal = window.term;
        const target = window.webTerminalTarget;
        if (!terminal?.onData || terminal.options.disableStdin || !target || !window.mbaTerminalReady?.() ||
            document.activeElement !== terminal.textarea || !document.hasFocus()) return null;
        const original = { ...target };
        let valid = true;
        const sameTarget = current => current && ['session', 'sessionId', 'pane', 'serverPid', 'paneMode']
            .every(key => current[key] === original[key]);
        const input = terminal.onData(() => { valid = false; });
        const changed = event => { if (!sameTarget(event.detail)) valid = false; };
        const disconnected = event => { if (event.detail !== 'connected') valid = false; };
        const blurred = () => { valid = false; };
        window.addEventListener('web-terminal-target', changed);
        window.addEventListener('web-terminal-connection', disconnected);
        window.addEventListener('blur', blurred);
        return {
            canInsert: () => valid && window.term === terminal && !terminal.options.disableStdin && window.mbaTerminalReady?.() &&
                document.hasFocus() && document.activeElement === terminal.textarea && sameTarget(window.webTerminalTarget),
            dispose: () => {
                input.dispose();
                window.removeEventListener('web-terminal-target', changed);
                window.removeEventListener('web-terminal-connection', disconnected);
                window.removeEventListener('blur', blurred);
            },
        };
    }
    function say(text, temporary = false) {
        clearTimeout(statusTimer);
        status.hidden = false;
        status.textContent = text;
        if (temporary)
            statusTimer = setTimeout(() => {
                status.hidden = true;
            }, 5000);
    }
    async function captureTarget() {
        const terminal = window.term;
        // Snapshot the last target confirmed by tmux output, not whichever
        // pane happens to be active when the HTTP request reaches the server.
        const observed = window.mbaTerminalReady?.() ? window.webTerminalTarget : null;
        const wasDisabled = terminal?.options.disableStdin;
        const buttons = [...bar.querySelectorAll('button')].map(button => [button, button.disabled]);
        if (terminal) terminal.options.disableStdin = true;
        buttons.forEach(([button]) => { button.disabled = true; });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
            const response = await fetch('/__terminal_upload', {
                method: 'POST', cache: 'no-store', redirect: 'manual', signal: controller.signal,
                headers: {
                    'X-Terminal-Action': 'capture',
                    'X-Terminal-View': observed ? (window.webTerminalViewId || '') : '',
                    'X-Terminal-Session': observed?.session || '',
                    'X-Terminal-Session-Id': observed?.sessionId || '',
                    'X-Terminal-Pane': observed?.pane || '',
                    'X-Terminal-Server-Pid': observed?.serverPid || '',
                },
            });
            if (!response.ok) return null;
            const target = await response.json();
            if (!/^[a-f0-9]{48}$/.test(target.ticket)) return null;
            if (target.target && (!/^\d+$/.test(target.target.windowIndex) || !/^\d+$/.test(target.target.paneIndex))) return null;
            return target;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
            if (terminal) terminal.options.disableStdin = !window.mbaTerminalReady?.() || wasDisabled;
            buttons.forEach(([button, disabled]) => { button.disabled = disabled; });
        }
    }
    function offerSavedPath(path, name, receipt, insertionState = 'manual') {
        const target = receipt?.target;
        say('Image saved: ' + name, true);
        const item = document.createElement('div');
        const message = document.createElement('div');
        message.setAttribute('role', 'status');
        message.textContent = insertionState === 'sent'
            ? `Image sent to window ${target.windowIndex}, pane ${target.paneIndex}. Check the terminal.`
            : insertionState === 'unknown'
                ? `Insertion not confirmed. Check the terminal before retrying; the saved path is available to copy.`
                : target
            ? `Saved ${name}. Captured target: window ${target.windowIndex}, pane ${target.paneIndex}. Check before inserting.`
            : `Saved ${name}. Original target unavailable; copy the path.`;
        const field = document.createElement('input');
        field.type = 'text';
        field.readOnly = true;
        field.value = path;
        field.setAttribute('aria-label', `Saved path for ${name}`);
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.textContent = 'Copy path';
        copy.onclick = async () => {
            try { await navigator.clipboard.writeText(path); message.textContent = 'Path copied: ' + name; }
            catch { field.focus(); field.select(); message.textContent = 'Select and copy the saved path: ' + name; }
        };
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = 'Dismiss';
        dismiss.setAttribute('aria-label', `Dismiss saved path for ${name}`);
        dismiss.onclick = () => item.remove();
        item.append(message, field, copy, dismiss);
        if (target && insertionState === 'manual') {
            const insert = document.createElement('button');
            insert.type = 'button';
            insert.textContent = 'Insert into captured pane';
            insert.onclick = async () => {
                insert.disabled = true;
                try {
                    const response = await fetch('/__terminal_upload', {
                        method: 'POST', cache: 'no-store', redirect: 'manual',
                        headers: { 'X-Terminal-Action': 'insert', 'X-Terminal-Target': receipt.ticket },
                    });
                    message.textContent = response.ok
                        ? 'Path sent to the captured pane. Check it before continuing.'
                        : 'Insertion not confirmed. Check the captured pane; the saved path is available to copy.';
                } catch {
                    message.textContent = 'Insertion result unknown. Check the captured pane before retrying; the path is available to copy.';
                }
            };
            item.append(insert);
        }
        results.append(item);
    }
    function offerRecovery(receipt, name) {
        say('Upload interrupted; the save result is unknown: ' + name);
        if (!receipt) return;
        const item = document.createElement('div');
        const message = document.createElement('div');
        message.setAttribute('role', 'status');
        message.textContent = `Upload interrupted: ${name}. Recover the saved path within ten minutes.`;
        const recover = document.createElement('button');
        recover.type = 'button';
        recover.textContent = 'Recover saved path';
        recover.onclick = async () => {
            recover.disabled = true;
            try {
                const response = await fetch('/__terminal_upload', {
                    method: 'POST', cache: 'no-store', redirect: 'manual',
                    headers: { 'X-Terminal-Action': 'result', 'X-Terminal-Target': receipt.ticket },
                });
                if (!response.ok) throw Error('Receipt unavailable');
                const result = await response.json();
                if (typeof result.path === 'string' && /^\/[^\x00-\x1f]*\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(result.path)) {
                    offerSavedPath(result.path, name, receipt);
                    item.remove();
                    return;
                }
                message.textContent = 'The save is not confirmed yet. Try recovery again.';
            } catch {
                message.textContent = 'Recovery unavailable. Check the connection and try again; receipts expire after ten minutes.';
            } finally { recover.disabled = false; }
        };
        item.append(message, recover);
        results.append(item);
    }
    async function upload(file, guard) {
        if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
            say('Unsupported image: ' + (file.name || 'clipboard image'));
            return;
        }
        if (file.size === 0 || file.size > 10 * 1024 * 1024) {
            say('Image must be between 1 byte and 10 MB: ' + (file.name || 'clipboard image'));
            return;
        }
        const name = file.name || 'clipboard image';
        say('Identifying the target for ' + name + '…');
        const target = await captureTarget();
        if (!target) {
            say('Unable to start upload safely. Check the connection and retry: ' + name);
            return;
        }
        return new Promise(resolve => {
            say('Uploading ' + name + '…');
            const x = new XMLHttpRequest();
            x.open('POST', '/__terminal_upload');
            x.setRequestHeader('Content-Type', 'application/octet-stream');
            if (target) x.setRequestHeader('X-Terminal-Target', target.ticket);
            x.timeout = 120000;
            x.upload.onprogress = e => {
                if (e.lengthComputable) say('Uploading ' + name + ': ' + Math.round((e.loaded * 100) / e.total) + '%');
            };
            x.onerror = () => {
                offerRecovery(target, name);
                resolve();
            };
            x.ontimeout = () => {
                offerRecovery(target, name);
                resolve();
            };
            x.onabort = () => { offerRecovery(target, name); resolve(); };
            x.onload = async () => {
                try {
                    let body = JSON.parse(x.responseText);
                    if (
                        x.status !== 201 ||
                        typeof body.path !== 'string' ||
                        !/^\/[^\x00-\x1f]*\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(body.path)
                    )
                        throw Error(body.error || 'Upload failed');
                    const receipt = target && body.targetBound === true ? target : null;
                    let insertionState = 'manual';
                    if (guard?.canInsert() && receipt?.target) {
                        insertionState = 'unknown';
                        try {
                            const response = await fetch('/__terminal_upload', {
                                method: 'POST', cache: 'no-store', redirect: 'manual',
                                headers: { 'X-Terminal-Action': 'insert-current', 'X-Terminal-Target': receipt.ticket },
                            });
                            if (response.ok) insertionState = 'sent';
                        } catch { /* The insert might have arrived; never retry automatically. */ }
                    }
                    offerSavedPath(body.path, name, receipt, insertionState);
                } catch (err) {
                    say('Upload failed: ' + name + ' — ' + (err.message || 'unknown error'));
                }
                resolve();
            };
            x.send(file);
        });
    }
    function enqueue(files, autoInsert = false) {
        if (busy) {
            say('An image is already uploading. Please wait.');
            return;
        }
        if (files.length !== 1) {
            say('Upload one image at a time.');
            return;
        }
        busy = true;
        const guard = autoInsert ? watchPasteTarget() : null;
        upload(files[0], guard).finally(() => {
            busy = false;
            guard?.dispose();
        });
    }
    picker.addEventListener('change', () => {
        enqueue([...picker.files]);
        picker.value = '';
    });
    document.addEventListener('dragover', e => {
        if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        }
    });
    document.addEventListener('drop', e => {
        if ([...e.dataTransfer.types].includes('Files')) {
            e.preventDefault();
            enqueue([...e.dataTransfer.files]);
        }
    });
    document.addEventListener(
        'paste',
        e => {
            const files = [...(e.clipboardData?.items || [])]
                .filter(i => i.kind === 'file' && i.type.startsWith('image/'))
                .map(i => i.getAsFile())
                .filter(Boolean);
            if (files.length) {
                e.preventDefault();
                e.stopImmediatePropagation();
                enqueue(files, true);
            }
        },
        true
    );
})();
