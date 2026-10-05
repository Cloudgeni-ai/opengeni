---
"@opengeni/runtime": patch
---

Malformed `apply_patch` arguments no longer stall a session on a human approval. The function `apply_patch` used on Chat Completions and Codex function transports now carries a static never-approval policy, so unparseable arguments return the ordinary model-visible parse error and the model can retry. An argument object without a recognized patch field returns a corrective error naming the expected shape. The tool now presents one required string field, `patch`, with a format description and example; the legacy structured and tuple forms are still accepted.
