import type { IDisposable, Terminal } from '@xterm/xterm';

// tmux copies mouse selections using OSC 52. Only accept a recent user drag;
// programs in the terminal must not be able to replace the clipboard at will.
export function createOsc52Clipboard(terminal: Terminal): IDisposable & {
    hasPending(): boolean;
    clear(): void;
} {
    const element = terminal.element;
    if (!element) throw new Error('Terminal must be open');
    let start: { x: number; y: number } | undefined;
    let lastDrag = 0;
    let pending = '';
    let expiry: ReturnType<typeof setTimeout> | undefined;

    function clear() {
        pending = '';
        if (expiry) clearTimeout(expiry);
        expiry = undefined;
    }
    function pointerDown(event: PointerEvent) {
        clear();
        start = event.isTrusted && event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
    }
    function pointerUp(event: PointerEvent) {
        if (event.isTrusted && start && Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) >= 4) {
            lastDrag = Date.now();
        }
        start = undefined;
    }
    function copy(event: ClipboardEvent) {
        if (pending && !terminal.hasSelection() && event.clipboardData) {
            event.clipboardData.setData('text/plain', pending);
            event.preventDefault();
            clear();
        }
    }
    element.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('pointerup', pointerUp, true);
    element.addEventListener('copy', copy);
    const osc = terminal.parser.registerOscHandler(52, data => {
        if (!lastDrag || Date.now() - lastDrag > 1500 || !document.hasFocus() || data.length > 1400000) return true;
        lastDrag = 0;
        const match = /^[cps0-7]*;([A-Za-z0-9+/]+={0,2})$/.exec(data);
        if (!match) return true;
        try {
            const bytes = Uint8Array.from(atob(match[1]), character => character.charCodeAt(0));
            if (bytes.length > 1048576) return true;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!text) return true;
            clear();
            pending = text;
            expiry = setTimeout(clear, 30000);
            if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
        } catch {
            // Ignore malformed or non-text OSC 52 data.
        }
        return true;
    });
    return {
        hasPending: () => pending !== '',
        clear,
        dispose: () => {
            clear();
            osc.dispose();
            element.removeEventListener('pointerdown', pointerDown, true);
            window.removeEventListener('pointerup', pointerUp, true);
            element.removeEventListener('copy', copy);
        },
    };
}
