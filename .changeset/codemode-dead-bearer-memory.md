---
"@opengeni/codemode": patch
"@opengeni/ogtool": patch
"@opengeni/contracts": patch
"@opengeni/api-router": patch
---

A script that keeps calling `ogtool` or the native `codemode` client after its turn ended no longer hammers the API: a bearer refused with 401, or with 403 `agent_attempt_caller_stale`, is remembered across processes in a private per-user marker (a hash, never the bearer), and later calls with it fail locally with the same error. A refused API request now also logs who sent it: the worker's hashed attempt key (`callerCorrelationId`) for an agent-attempt bearer, a hashed credential key otherwise, and the User-Agent product.
