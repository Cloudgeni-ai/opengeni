---
"@opengeni/network": patch
---

A request that follows a client tool search on a Responses WebSocket now sends only its new items again. The Codex normalizer strips the replayed `tool_search_call`'s provider id and "completed" status, so the continuation check never recognized it and every request after a tool search resent the whole input. The check now treats those two fields of a `tool_search_call` the same way it already does for function calls; any other difference still sends the full request.
