---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/testing": patch
---

The function `apply_patch` tool takes an optional `then` shell command. It runs once, only after every patch operation applied, through the same `exec_command` path (sandbox, lean defaults, turn cancellation, finish floor, secret references and leak guard, truncation and approval policy), inside the exclusive edit call, and its result follows the patch result in the same tool output. A failed patch leaves it unrun and says so. The tool description notes that one patch can change several files, and one system-prompt sentence suggests batching decided edits and passing the follow-up check as `then`.

The function `apply_patch` is applied one file section at a time: an Add File section without lines creates an empty file instead of failing the whole patch, an Invalid Context failure is followed by the closest matching region of the file with line numbers, a section whose hunks were written out of file order is retried in file order when each hunk matches exactly one place, and each section reports its own result.

All of this is on by default; `OPENGENI_EXPERIMENT_APPLY_PATCH_THEN=false` restores the previous plain tool.
