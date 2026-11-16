---
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agent turns with long histories use less worker CPU per model request. The history prefix check compares canonical items instead of hashing the whole history, model context snapshots reuse unchanged content from the previous request, request copies avoid `structuredClone` for plain data, model provider and pricing settings are parsed once per value, and the row-level security scope statement is built once per shape. Outputs, stored snapshots and history rejections are unchanged.
