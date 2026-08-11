---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep the normal remote context-compaction request unchanged, then recover once from an exact context-length rejection by temporarily reducing only tool-result bodies. Preserve the full durable history unless the retry returns a valid compaction checkpoint.
