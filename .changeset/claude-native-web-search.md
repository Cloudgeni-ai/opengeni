---
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/worker-bundle": patch
---

Claude models get Anthropic's server-side web search when web search is enabled. Searches, results and citations are kept in history and sent back exactly as Anthropic requires, deferred and paused searches continue correctly, other providers and compaction see readable search facts, and the search tool is part of the stable cached prefix. A cited answer is one reply, a paused turn's context size is its last request, failed searches never wait as pending tool calls, and billed searches are counted.
