#!/usr/bin/env bash
# Teardown the desktop stack. The recording is SIGINT'd first (not SIGKILL) so
# ffmpeg finalizes the moov atom (+faststart) and the MP4 is not truncated.
set -uo pipefail
RUN=/tmp/opengeni-desktop

# Stop the recorder gracefully so the file is playable, then the rest.
if [ -f "$RUN/record.pid" ]; then
  kill -INT "$(cat "$RUN/record.pid")" 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$(cat "$RUN/record.pid")" 2>/dev/null || break; sleep 0.1; done
  rm -f "$RUN/record.pid"
fi
for name in novnc x11vnc xfce xvfb; do
  [ -f "$RUN/$name.pid" ] || continue
  kill "$(cat "$RUN/$name.pid")" 2>/dev/null || true
  rm -f "$RUN/$name.pid"
done
echo "OPENGENI_DESKTOP_DOWN"
