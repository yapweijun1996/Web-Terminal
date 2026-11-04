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
    let busy = false,
        statusTimer;
    function say(text, temporary = false) {
        clearTimeout(statusTimer);
        status.hidden = false;
        status.textContent = text;
        if (temporary)
            statusTimer = setTimeout(() => {
                status.hidden = true;
            }, 5000);
    }
    function pastePath(value) {
        const input = document.querySelector('.xterm-helper-textarea');
        if (!input || typeof window.mbaTerminalReady !== 'function' || !window.mbaTerminalReady()) return false;
        const quote = /^[A-Za-z0-9_./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\\''") + "'";
        const data = new DataTransfer();
        data.setData('text/plain', quote);
        input.focus();
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        return true;
    }
    function insertOrOffer(path, name) {
        if (document.hasFocus() && pastePath(path)) {
            say('Added image path: ' + name, true);
            return;
        }
        say('Image saved: ' + name + ' ');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Insert path';
        button.onclick = () => {
            if (pastePath(path)) say('Added image path: ' + name, true);
            else status.firstChild.textContent = 'Terminal disconnected. Reconnect, then insert: ' + name + ' ';
        };
        status.append(button);
    }
    function upload(file) {
        return new Promise(resolve => {
            if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
                say('Unsupported image: ' + (file.name || 'clipboard image'));
                return resolve();
            }
            if (file.size === 0 || file.size > 10 * 1024 * 1024) {
                say('Image must be between 1 byte and 10 MB: ' + (file.name || 'clipboard image'));
                return resolve();
            }
            const name = file.name || 'clipboard image';
            say('Uploading ' + name + '…');
            const x = new XMLHttpRequest();
            x.open('POST', '/__terminal_upload');
            x.setRequestHeader('Content-Type', 'application/octet-stream');
            x.timeout = 120000;
            x.upload.onprogress = e => {
                if (e.lengthComputable) say('Uploading ' + name + ': ' + Math.round((e.loaded * 100) / e.total) + '%');
            };
            x.onerror = () => {
                say('Upload failed: ' + name);
                resolve();
            };
            x.ontimeout = () => {
                say('Upload timed out: ' + name);
                resolve();
            };
            x.onload = () => {
                try {
                    let body = JSON.parse(x.responseText);
                    if (
                        x.status !== 201 ||
                        typeof body.path !== 'string' ||
                        !/^\/[^\x00-\x1f]*\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(body.path)
                    )
                        throw Error(body.error || 'Upload failed');
                    insertOrOffer(body.path, name);
                } catch (err) {
                    say('Upload failed: ' + name + ' — ' + (err.message || 'unknown error'));
                }
                resolve();
            };
            x.send(file);
        });
    }
    function enqueue(files) {
        if (busy) {
            say('An image is already uploading. Please wait.');
            return;
        }
        if (files.length !== 1) {
            say('Upload one image at a time.');
            return;
        }
        busy = true;
        upload(files[0]).finally(() => {
            busy = false;
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
                enqueue(files);
            }
        },
        true
    );
})();
