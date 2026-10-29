---
"@opengeni/runtime": patch
---

Tool search's decision model sees the full name of an MCP tool whose model name was shortened to fit the model's name limit. Shortened siblings such as several `…_promote_to_` tools could only be told apart by a digest, so a search that named one of them could get another. The agent's prompt and tool list are unchanged.
