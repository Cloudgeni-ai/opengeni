---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Keep restored Modal checkpoints valid across live workspace writes, serialize
lease reaping with concurrent acquisition, and rotate image or rig changes
through durable checkpoint capture instead of discarding provider ownership.
