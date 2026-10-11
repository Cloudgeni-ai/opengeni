---
"@opengeni/db": patch
"@opengeni/core": patch
---

Remove the legacy Claude subscription runtime now that Claude runs on the shared subscription core. Claude turns, refusals, waits and readiness use only the shared core; without the Claude cutover a Claude turn, a single Claude model call or a Claude custom-model admission fails closed instead of using the old account pool. The no-legacy runtime check now covers Claude.
