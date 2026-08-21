---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Take the canonical turn/attempt lock prefix before retaining a screenshot, retry that idempotent prepare on deadlock, and keep leftover persistence failures from failing the tool.
