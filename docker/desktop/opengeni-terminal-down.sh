#!/usr/bin/env bash
# Teardown the ttyd PTY server (best-effort). Mirrors opengeni-desktop-down.sh.
set -uo pipefail
pkill -x ttyd 2>/dev/null || true
echo "OPENGENI_TERMINAL_DOWN"
