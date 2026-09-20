---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Persist the periodic workspace capture attempt clock so failed snapshots respect the configured interval instead of blocking commands again on the next heartbeat. Forced recovery captures still bypass periodic cadence without bypassing ownership or active-capture fences.