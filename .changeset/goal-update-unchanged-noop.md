---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

`goal_update` with the goal's own text, success criteria and policy is now an idempotent no-op: it writes no revision, proposal or event and returns `outcome: "unchanged"` with a plain message, instead of failing on the objective-revision trigger. The files and Knowledge MCP surfaces now share the first-party guard that turns raw database errors into typed tool results, which name the kind of refusal (conflict, missing reference, broken data rule, value too long, not allowed) and log the error server-side only.
