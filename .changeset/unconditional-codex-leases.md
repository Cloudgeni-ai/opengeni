---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Make durable Codex credential leasing unconditional, preserve rotation-off as an active-account-only capacity policy, and recover definitive credential failures through same-turn failover or durable capacity waiting.