#!/bin/bash
# The command of a GitHub Actions runner's sandbox (compute ADR 23).
#
# Starts Docker for the job, then the runner as `runner`, with the
# just-in-time configuration the pool gave this sandbox
# (ACTIONS_RUNNER_INPUT_JITCONFIG). The runner takes one job and exits;
# the pool ends the sandbox then. While the runner lives it counts as a
# running command (compute's activity files), so a job that waits quietly
# on a test or a deploy is never put to sleep. Without a configuration (a
# template being prepared) it runs Docker alone.
set -euo pipefail

log=/var/log/dockerd.log
dockerd >"$log" 2>&1 &
for _ in $(seq 150); do
  if docker info >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
if ! docker info >/dev/null 2>&1; then
  echo "dockerd did not start; jobs run without Docker:" >&2
  tail -n 20 "$log" >&2
fi

if [ -z "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ]; then
  echo "no runner configuration: Docker alone"
  wait
  exit 0
fi

mkdir -p /run/compute/activity
echo 1 >"/run/compute/activity/runner.$$"
cd /home/runner
exec setpriv --reuid=runner --regid=runner --init-groups \
  env HOME=/home/runner USER=runner LOGNAME=runner ./run.sh
