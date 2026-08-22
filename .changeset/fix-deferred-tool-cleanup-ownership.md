---
"@opengeni/runtime": patch
---

Keep already-published eager and in-process model tool servers alive when deferred MCP preparation fails, so recovery surfaces the original preparation error and finalization still releases every resource exactly once.