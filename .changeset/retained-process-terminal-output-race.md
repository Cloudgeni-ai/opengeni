---
"@opengeni/db": patch
"@opengeni/runtime": patch
---

A `write_stdin` poll that races the reaper's settlement of an exited background command now returns the durable exit result instead of failing the turn with `sandbox_mutation_output_rejected`. The provider call is still made once and never replayed, and its output stays rejected.
