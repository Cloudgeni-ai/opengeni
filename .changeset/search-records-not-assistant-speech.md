---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Hosted web-search results are replayed to the model as a labelled search record instead of as the assistant's own message, so models no longer imitate them and write raw search JSON into the chat. A record never separates a tool call from its result. Earlier messages that were only such a copy are replayed as a short note, a copy is not shown while it streams, and a reply that is only a copy gets the usual nudge for a real final answer.
