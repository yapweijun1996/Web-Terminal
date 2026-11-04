'use strict';

(function (root, factory) {
    const ConnectionLifecycle = factory();
    if (typeof module === 'object' && module.exports) module.exports = ConnectionLifecycle;
    if (root) root.WebTerminalConnectionLifecycle = ConnectionLifecycle;
})(typeof window === 'object' ? window : null, function () {
    return class ConnectionLifecycle {
        constructor({
            requestToken,
            openSocket,
            onState,
            onInput,
            setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
            clearTimer = timer => globalThis.clearTimeout(timer),
        }) {
            this.requestToken = requestToken;
            this.openSocket = openSocket;
            this.onState = onState;
            this.onInput = onInput;
            this.setTimer = setTimer;
            this.clearTimer = clearTimer;
            this.state = 'idle';
            this.attempts = 0;
            this.pending = false;
            this.awaitingSocket = false;
            this.timer = null;
            this.stopped = false;
        }

        setState(state) {
            this.state = state;
            this.onState(state);
        }

        start() {
            if (this.state !== 'idle' || this.stopped) return;
            this.onInput(false);
            this.setState('connecting');
            void this.attempt();
        }

        async attempt() {
            if (this.stopped || this.pending || this.awaitingSocket || this.state === 'connected') return;
            this.pending = true;
            let result;
            try { result = await this.requestToken(); } catch { result = 'unavailable'; }
            this.pending = false;
            if (this.stopped) return;
            if (result === 'auth') {
                this.setState('auth-required');
                return;
            }
            if (result !== 'ok') {
                this.schedule();
                return;
            }
            this.awaitingSocket = true;
            try { this.openSocket(); } catch { this.awaitingSocket = false; this.schedule(); }
        }

        socketOpened() {
            if (this.stopped) return;
            this.awaitingSocket = false;
            this.attempts = 0;
            this.onInput(true);
            this.setState('connected');
        }

        socketClosed() {
            if (this.stopped) return;
            this.awaitingSocket = false;
            this.onInput(false);
            this.schedule();
        }

        schedule() {
            if (this.stopped || this.timer !== null) return;
            this.attempts++;
            if (this.attempts > 6) {
                this.setState('offline');
                return;
            }
            this.setState('reconnecting');
            const delay = Math.min(1000 * 2 ** (this.attempts - 1), 15000);
            this.timer = this.setTimer(() => {
                this.timer = null;
                void this.attempt();
            }, delay);
        }

        retry() {
            if (this.stopped || this.pending || this.awaitingSocket || !['offline', 'auth-required'].includes(this.state)) return;
            this.attempts = 0;
            this.setState('reconnecting');
            void this.attempt();
        }

        stop() {
            this.stopped = true;
            if (this.timer !== null) this.clearTimer(this.timer);
            this.timer = null;
            this.onInput(false);
        }
    };
});
