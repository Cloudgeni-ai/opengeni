#!/usr/bin/env bash
# Best-effort: make the forwarded API port public so the browser-served web
# app can call it without GitHub's port auth (XHR cannot pass the private-port
# auth redirect). The default Codespaces token sometimes lacks the codespace
# scope, so fall back to instructions instead of failing the container start.
set -uo pipefail

if [ -z "${CODESPACE_NAME:-}" ]; then
  exit 0
fi

if gh codespace ports visibility 8000:public -c "$CODESPACE_NAME" 2>/dev/null; then
  echo "Port 8000 (api) is now public."
else
  echo "Could not set port 8000 to public automatically."
  echo "In the Ports panel, right-click port 8000 -> Port Visibility -> Public,"
  echo "otherwise the web app cannot reach the API from your browser."
fi
exit 0
