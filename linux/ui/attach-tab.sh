#!/bin/sh
set -eu
export LANG=C.UTF-8
exec tmux -u -L "$1" new-session -A -s "$2"
