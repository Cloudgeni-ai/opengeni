---
"@opengeni/worker-bundle": patch
---

Fix Skill creation when a model sends the literal string "null" as its expected revision. Normalize that creation sentinel and validate save arguments before database access, while preserving scope, Learning policy, stale-write protection and operation replay.
