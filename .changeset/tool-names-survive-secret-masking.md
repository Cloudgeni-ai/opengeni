---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

A chat no longer stops with "Invalid 'input[N].tools[M].name': string does not match pattern" after a saved secret's value happens to appear inside a tool name. Secret masking now leaves tool names alone, and tool names already stored in a chat's history in a form a provider rejects (a masked reference, a dotted `server.tool` name, or any other name outside letters, digits, `_` and `-` up to 64 characters) are mapped back to the tool they denote, or to a stable valid alias, when the history is sent again. This applies to every provider: OpenAI and Codex, Chat Completions routes and gateways, and Claude. Retry works on a chat that already failed. Provider invalid-request errors are now counted by the request path they name (`opengeni_model_invalid_requests_total`, monitoring only) and shown on the Runtime Failures dashboard.
