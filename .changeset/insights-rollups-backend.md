---
"@opengeni/contracts": patch
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Add unified workspace/organization usage and visible-call readers over recorded
facts without changing debit or access semantics.
Distinguish deleted retained usage from private amounts and expose the prior
cache denominator and historical telemetry coverage.
Bound successful responses to a 60-second, authorization/visibility-fenced server
cache and return an actionable friendly error for statement timeouts.