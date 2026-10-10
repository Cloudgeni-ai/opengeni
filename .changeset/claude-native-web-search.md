---
"@opengeni/runtime": patch
"@opengeni/config": patch
---

Claude models get Anthropic's server-side web search when web search is enabled. Searches, results and citations are kept in history and sent back exactly as Anthropic requires, deferred and paused searches continue correctly, other providers and compaction see readable search facts, and the search tool is part of the stable cached prefix.
