---
"@opengeni/runtime": patch
---

A file edit (`apply_patch`) now runs in model order relative to the other tool calls in the same model response. It starts after every earlier call has finished, and later calls start after it has finished; other calls still run concurrently. Previously a batch such as "edit a file, then `git add` it" ran both at once, so the command could run before the file existed.
