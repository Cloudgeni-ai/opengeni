#!/bin/bash
# The command of a GitHub Actions runner's sandbox (compute ADR 23).
#
# Starts Docker for the job and waits until the sandbox is ready: until
# Docker answers, and the image's own check, COMPUTE_RUNNER_READY (a shell
# command), succeeds if it sets one. Only then does it start the runner as
# `runner`, with the just-in-time configuration the pool gave this sandbox
# (ACTIONS_RUNNER_INPUT_JITCONFIG): GitHub gives a job only to a runner
# that has connected, so no job lands where Docker is not up yet. A
# sandbox started from a template on a busy host can take well over a
# minute to bring Docker up, so there is no limit on the wait but the
# sandbox's own timeout; a dockerd that exits is started again. The
# runner takes one job and exits; the pool ends the sandbox then. While
# the runner lives it counts as a running command (compute's activity
# files), so a job that waits quietly on a test or a deploy is never put
# to sleep. Without a configuration (a template being prepared) it runs
# Docker alone.
#
# COMPUTE_RUNNER_LOG, COMPUTE_RUNNER_ACTIVITY and COMPUTE_RUNNER_HOME move
# the dockerd log, the activity files and the runner's home, for tests.
set -euo pipefail

log=${COMPUTE_RUNNER_LOG:-/var/log/dockerd.log}
activity=${COMPUTE_RUNNER_ACTIVITY:-/run/compute/activity}
home=${COMPUTE_RUNNER_HOME:-/home/runner}

ready() {
  docker info >/dev/null 2>&1 &&
    { [ -z "${COMPUTE_RUNNER_READY:-}" ] || bash -c "$COMPUTE_RUNNER_READY" >/dev/null 2>&1; }
}

dockerd >>"$log" 2>&1 &
dockerd_pid=$!
said=0
until ready; do
  if ! kill -0 "$dockerd_pid" 2>/dev/null; then
    echo "dockerd exited; it starts again:" >&2
    tail -n 20 "$log" >&2
    sleep 1
    dockerd >>"$log" 2>&1 &
    dockerd_pid=$!
  fi
  sleep 0.2
  if [ $((SECONDS - said)) -ge 30 ]; then
    said=$SECONDS
    echo "waiting for the sandbox to be ready (${SECONDS} s)" >&2
  fi
done
echo "ready after ${SECONDS} s"

if [ -z "${ACTIONS_RUNNER_INPUT_JITCONFIG:-}" ]; then
  echo "no runner configuration: Docker alone"
  wait
  exit 0
fi

mkdir -p "$activity"
echo 1 >"$activity/runner.$$"
cd "$home"
exec setpriv --reuid=runner --regid=runner --init-groups \
  env HOME="$home" USER=runner LOGNAME=runner ./run.sh
