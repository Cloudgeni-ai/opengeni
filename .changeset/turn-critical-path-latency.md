---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agent turns spend less time before each model request. The checks run before every model request (task usage limit, funding, workspace allowance and monthly limits) now read in parallel and still report the same refusal as before. Packaged Skills and interaction tool schemas are prepared once per process instead of on every turn.
