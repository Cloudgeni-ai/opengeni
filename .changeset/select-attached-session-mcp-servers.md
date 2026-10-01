---
"@opengeni/core": patch
"@opengeni/contracts": patch
"@opengeni/sdk": patch
---

A top-level `createSession` now selects every server it attaches through `mcpServers`, whether `tools` is omitted or explicit (including `tools: []`). Previously an attached server that `tools` did not name was stored but never contacted, so the model reported that no tools were available. An explicit ref for the same id is kept unchanged, so `tools` is only needed to set `eager` or `optional`.
