---
"@opengeni/sdk": patch
---

The packaged session app opens its workspace for external users behind a session proxy. Their access inventory is empty, so the proxy's `access/me` now carries the workspace's effective grant instead of filtering the inventory, which had left the app showing "This workspace isn't available".
