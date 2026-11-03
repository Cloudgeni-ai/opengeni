---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
---

A chat no longer stops with "Invalid 'input[N].tools[M].name': string does not match pattern" after a saved secret's value happens to appear inside a tool name. Secret masking now leaves tool names alone, and tool names already stored in a chat's history in an invalid form (a masked reference or a dotted `server.tool` name) are mapped back to the tool they denote when the history is sent again, so Retry works on a chat that already failed.
