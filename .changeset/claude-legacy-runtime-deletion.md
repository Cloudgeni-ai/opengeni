---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Remove the legacy Claude subscription runtime now that Claude runs on the shared subscription core. Claude turns, refusals, waits and readiness use only the shared core; without the Claude cutover a Claude turn fails closed instead of using the old account pool. Organization Claude custom models are offered and admitted only while the shared core serves the model in that workspace (an enabled cutover and a usable shared Claude connection that allows it); otherwise they are refused. Workspace-scoped Claude custom models are not offered for new selections on the shared core, and their admission check follows the same core rule. A single Claude model call (the API model-calls endpoint) fails closed with capacity unavailable in every case, including after the cutover, until the shared core serves it. Until the shared core serves them, the Claude account, usage, sign-in, setup-token and access-policy endpoints keep their permission checks (the strictest workspace check where the old check depended on the account's scope) and then answer 503 instead of reading or writing the old account pool. The no-legacy runtime check now covers Claude.
