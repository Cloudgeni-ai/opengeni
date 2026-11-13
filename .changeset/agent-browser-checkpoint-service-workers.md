---
"@opengeni/agent-host": patch
---

The agent ships the embedded browser controller whose browser checkpoints leave sites' service worker caches behind, so pausing and resuming a managed browser for a large web app moves a few MB instead of hundreds.
