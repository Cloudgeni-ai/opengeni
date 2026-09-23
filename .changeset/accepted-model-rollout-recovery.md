---
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Preserve accepted Codex Astra turns across the implicit prompt-caching metadata
rollout. Recover typed model-definition setup mismatches with bounded same-turn
retries and truthful failure diagnostics, without changing accepted model authority
or replaying completed external work.