#!/bin/sh
set -eu
umask 077

: "${WEB_TERMINAL_RUNTIME_DIR:?Set a private runtime directory}"
: "${WEB_TERMINAL_CLIENT_HTML:?Set the built client path}"
: "${WEB_TERMINAL_TMUX_SERVER:?Set a dedicated tmux server name}"
: "${WEB_TERMINAL_START_DIR:?Set the session start directory}"
case "$WEB_TERMINAL_RUNTIME_DIR" in /*) ;; *) echo 'Runtime directory must be absolute' >&2; exit 1 ;; esac
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOCKET="$WEB_TERMINAL_RUNTIME_DIR/terminal.sock"
TTYD_BIN=${TTYD_BIN:-ttyd}
test -d "$WEB_TERMINAL_RUNTIME_DIR" || { echo 'Runtime directory is missing' >&2; exit 1; }
test -f "$WEB_TERMINAL_CLIENT_HTML" || { echo 'Client HTML is missing' >&2; exit 1; }
node - "$WEB_TERMINAL_RUNTIME_DIR" <<'NODE'
const fs = require('node:fs');
const dir = fs.lstatSync(process.argv[2]);
if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) !== 0) {
    throw new Error('Runtime directory must be private and owned by the current user');
}
NODE
if [ -e "$SOCKET" ] || [ -L "$SOCKET" ]; then
    echo 'Terminal socket already exists; verify its owner before removal' >&2
    exit 1
fi
export WEB_TERMINAL_TMUX_SERVER WEB_TERMINAL_START_DIR
exec "$TTYD_BIN" --interface "$SOCKET" --writable --check-origin --url-arg --ping-interval 30 \
    --index "$WEB_TERMINAL_CLIENT_HTML" --client-option lineHeight=1.25 \
    --client-option fontSize=16 "$SCRIPT_DIR/attach.sh"
