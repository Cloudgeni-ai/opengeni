---
"@opengeni/browserd": patch
---

On Linux machines with a systemd user manager, each managed browser now runs in its own transient scope (`opengeni-browser-<id>.scope`) under `opengeni-browsers.slice` instead of inside the agent's service. Stopping, restarting or updating the agent service therefore no longer kills any of a browser's processes (previously its renderer, GPU and utility processes died with the service, crashing every tab), and each browser's memory and CPU are visible per browser. The slice sets no resource limits. The launch keeps Chrome's process ID unchanged, and Chromium's own move of its main process into an app scope is undone after launch so the whole browser stays one unit. Machines without a reachable user manager launch browsers exactly as before.
