---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Stamp session activity with transaction IDs instead of serializing new writers on a workspace counter. Preserve gap-free, at-least-once incremental monitoring with snapshot xmin watermarks, restart legacy cursors conservatively, and retain the old database gate during rolling upgrades.
