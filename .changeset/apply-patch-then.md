---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/testing": patch
---

The function `apply_patch` tool takes an optional `then` shell command. It runs once, only after every patch operation applied, through the same `exec_command` path (sandbox, lean defaults, turn cancellation, finish floor, secret references and leak guard, truncation and approval policy), inside the exclusive edit call, and its result follows the patch result in the same tool output. A failed patch leaves it unrun and says so. `OPENGENI_EXPERIMENT_APPLY_PATCH_THEN=false` removes the argument. `OPENGENI_EXPERIMENT_APPLY_PATCH_THEN_GUIDANCE=true` (off by default) adds one system-prompt sentence suggesting it, for A/B evaluation.
