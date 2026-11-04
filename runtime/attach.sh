#!/bin/sh
set -eu

: "${WEB_TERMINAL_TMUX_SERVER:?Set a dedicated tmux server name}"
: "${WEB_TERMINAL_START_DIR:?Set the session start directory}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMUX_BIN=${TMUX_BIN:-tmux}

if [ "$#" -gt 1 ]; then echo 'Invalid view ID' >&2; exit 1; fi
if [ "$#" -eq 1 ]; then
    case "$1" in ''|*[!a-f0-9-]*) echo 'Invalid view ID' >&2; exit 1 ;; esac
    printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' || { echo 'Invalid view ID' >&2; exit 1; }
    view="view-$1-$$"
else
    view="view-$$-$(uuidgen)"
fi
base() { "$TMUX_BIN" -u -L "$WEB_TERMINAL_TMUX_SERVER" -f "$SCRIPT_DIR/tmux.conf" "$@"; }
if ! base has-session -t '=workspace' 2>/dev/null; then
    base new-session -d -s workspace -c "$WEB_TERMINAL_START_DIR" || base has-session -t '=workspace'
fi
base new-session -d -t workspace -s "$view"
cleanup() { base kill-session -t "=$view" >/dev/null 2>&1 || :; }
trap cleanup EXIT HUP INT TERM
# Only the current client understands and removes the private metadata prefix.
# A legacy client has no view ID and must retain the server's normal title.
if [ "$#" -eq 1 ]; then
    base set-option -t "=$view:" set-titles-string '__WEB_TERMINAL_TARGET__|#{session_name}|#{session_id}|#{pane_id}|#{pid}|#{window_index}|#{pane_index}|#{pane_mode}|#{pane_title}'
    base set-option -t "=$view:" set-titles on
fi
base attach-session -t "=$view"
