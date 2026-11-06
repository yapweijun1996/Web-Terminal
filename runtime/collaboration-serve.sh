#!/bin/sh
set -eu

# There is no authenticated gateway that mediates every input path yet.
# Refuse to start instead of presenting the legacy writable origin as secure.
echo 'Collaborative terminal unavailable: authenticated input mediation is not implemented.' >&2
exit 1
