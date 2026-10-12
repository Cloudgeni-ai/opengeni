---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove the legacy Claude subscription runtime now that Claude runs on the shared subscription core. Claude turns, refusals, waits and readiness use only the shared core; without the Claude cutover a Claude turn, a single Claude model call or a Claude custom-model admission fails closed instead of using the old account pool. Until the shared core serves them, the Claude account, usage, sign-in, setup-token and access-policy endpoints authenticate the caller and then answer 503 instead of reading or writing the old account pool. The no-legacy runtime check now covers Claude.
