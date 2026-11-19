---
"@opengeni/network": patch
---

A request that follows a hosted web search on a Responses WebSocket now sends only its new items again. The Codex normalizer strips the replayed `web_search_call`'s provider `ws_` id, so the continuation check never recognized it, and every request after a web search resent the whole input. The backend renders a full input differently from the chain it holds, so those requests missed the prompt cache back to the first differing item. The check now ignores that id, as it already does for function calls and tool searches. A different action or status still sends the full request.
