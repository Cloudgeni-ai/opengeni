---
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/contracts": patch
---

Share the complete default model and reasoning-effort fallback between client config and omitted-model session creation when the deployment default is stably blocked.

Preserve older nonempty allowedModels parsers when no model is admitted by returning one explicit unavailable legacyModelFallback hint, while keeping models as the exact admitted set and leaving creation gates unchanged.

Keep cookie-only managed browser bootstrap unscoped so account reconciliation can load before actor-fenced workspace reads.