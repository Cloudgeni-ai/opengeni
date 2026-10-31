---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Hosted web-search results reach the model as a labelled search record in the user role instead of as the assistant's own message, so models stop imitating them and writing raw search JSON into the chat. The form belongs to the session: new sessions use the record from their first turn, and an existing session switches only once its history no longer holds a search (after compaction or clearing), so no text an earlier request sent changes and prompt caches stay intact. A record never separates a tool call from its result. In every session, a model-written copy is not shown while it streams, and a reply that is only a copy gets the usual nudge for a real final answer.
