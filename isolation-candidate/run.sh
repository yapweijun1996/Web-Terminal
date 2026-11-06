#!/bin/sh
set -eu
candidate_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec docker run --rm --pull=never \
  --name "slice2b-isolation-$$" --label slice2b.fixture=20261106 \
  --network none --read-only --user 0:0 --security-opt no-new-privileges \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN \
  --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL \
  --pids-limit 80 --memory 256m --tmpfs /tmp:rw,mode=1777 \
  --mount "type=bind,src=$candidate_dir,dst=/project/isolation-candidate,readonly" \
  --entrypoint node web-terminal-test:wt009-final-20261104 \
  /project/isolation-candidate/runner.js
