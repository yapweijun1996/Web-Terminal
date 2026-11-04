#!/bin/sh
set -eu

: "${WEB_TERMINAL_TMUX_SERVER:?Set a dedicated tmux server name}"
: "${WEB_TERMINAL_START_DIR:?Set the session start directory}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMUX_BIN=${TMUX_BIN:-tmux}

base() { "$TMUX_BIN" -u -L "$WEB_TERMINAL_TMUX_SERVER" -f "$SCRIPT_DIR/tmux.conf" "$@"; }
if ! base has-session -t '=workspace' 2>/dev/null; then
    base new-session -d -s workspace -c "$WEB_TERMINAL_START_DIR" || base has-session -t '=workspace'
fi
view="view-$$-$(uuidgen)"
base new-session -d -t workspace -s "$view"
cleanup() { base kill-session -t "=$view" >/dev/null 2>&1 || :; }
trap cleanup EXIT HUP INT TERM
base attach-session -t "=$view"
