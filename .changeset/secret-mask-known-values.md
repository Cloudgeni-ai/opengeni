---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Known secret values are masked before they are stored or shown to the model. Each agent attempt remembers the values its secret references resolve to, the credentials Opengeni injects (Codemode bearer, git and broker tokens, host run credentials, MCP header values) and, best effort, the hosted vault values the session tree used before. Tool results, tool-call arguments, model input, context compaction, model-context snapshots and stored conversation text (events, history, messages, goals, notes, run state) replace a known value, and its JSON-escaped, percent-encoded and base64 forms, with the reference that resolved it. Values shorter than 8 characters are left alone, and masking never fails a tool call or a turn. The pure matchers (`SecretValueMemory`, `compileSecretValueMasks`, `maskSecretValues`, `maskSecretValuesInText`) are exported from `@opengeni/contracts`.
