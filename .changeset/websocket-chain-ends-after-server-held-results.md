---
"@opengeni/network": patch
"@opengeni/codex": patch
---

A Responses WebSocket response that contains a hosted web search, file search or code interpreter call no longer starts a continuation chain. The backend keeps those calls' results with the response it holds but leaves them out of the output item, so a continued chain caches the results while every later full request of the chat (a remote compaction checkpoint, a new connection) replays the item without them and misses the prompt cache from the first such call onwards. The next request now replays the call once, which misses only from that call, and every later request and checkpoint matches the cache again. `SERVER_HELD_RESULT_ITEM_TYPES` and `holdsServerOnlyResults` in `@opengeni/network/responses-replay` define the types.
