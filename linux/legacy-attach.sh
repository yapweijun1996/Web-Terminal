#!/bin/sh
set -eu
export LANG=C.UTF-8
socket=linux-web-terminal
if ! tmux -L "$socket" has-session -t =shared 2>/dev/null; then
  tmux -L "$socket" new-session -d -s shared || tmux -L "$socket" has-session -t =shared
fi
exec tmux -u -L "$socket" new-session -t shared \; set-option destroy-unattached on
