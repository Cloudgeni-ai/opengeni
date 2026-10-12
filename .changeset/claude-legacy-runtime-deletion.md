---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove the legacy Claude subscription runtime now that Claude runs on the shared subscription core. Claude turns, refusals, waits and readiness use only the shared core; without the Claude cutover a Claude turn fails closed instead of using the old account pool. Organization and workspace Claude custom models are admitted only while the shared core serves the model in that workspace (an enabled cutover and a usable shared Claude connection that allows it); otherwise they are refused. A single Claude model call (the API model-calls endpoint) fails closed with capacity unavailable in every case, including after the cutover, until the shared core serves it. Until the shared core serves them, the Claude account, usage, sign-in, setup-token and access-policy endpoints keep their existing permission checks and then answer 503 instead of reading or writing the old account pool. The no-legacy runtime check now covers Claude.
