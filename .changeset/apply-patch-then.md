---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/testing": patch
---

The function `apply_patch` tool takes an optional `then` shell command. It runs once, only after every patch operation applied, through the same `exec_command` path (sandbox, lean defaults, turn cancellation, finish floor, secret references and leak guard, truncation and approval policy), inside the exclusive edit call, and its result follows the patch result in the same tool output. A failed patch leaves it unrun and says so. `OPENGENI_EXPERIMENT_APPLY_PATCH_THEN=false` removes the argument. `OPENGENI_EXPERIMENT_APPLY_PATCH_THEN_GUIDANCE=true` (off by default) adds one system-prompt sentence suggesting it, for A/B evaluation.

`OPENGENI_EXPERIMENT_APPLY_PATCH_ROBUST=true` (off by default) applies the function `apply_patch` one file section at a time: an Add File section without lines creates an empty file instead of failing the whole patch, and an Invalid Context failure is followed by the closest matching region of the file, with line numbers; a section whose hunks were written out of file order is retried in file order when each hunk matches exactly one place.
