#!/bin/sh
set -eu
export LANG=C.UTF-8
if [ "$#" -eq 5 ]; then
    guard="#{&&:#{==:#{session_name},$2},#{&&:#{==:#{pid},$4},#{==:#{@web-workspace-terminal},$5}}}"
    exec tmux -u -L "$1" if-shell -F -t "$3" "$guard" "attach-session -t '$3'"
fi
exec tmux -u -L "$1" new-session -A -s "$2"
