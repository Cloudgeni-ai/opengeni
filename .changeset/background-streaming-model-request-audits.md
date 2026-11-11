---
"@opengeni/worker-bundle": patch
---

Model request audits for a stream already under way (headers, first byte or event, progress) are written in the background, in order, so the provider's response no longer waits on a database append. The started and terminal audits stay awaited.
