---
"@opengeni/db": patch
---

Session message search checks message text in the database. A search over a large workspace used to read about 33 messages per request, and once the database step took longer than the request's time budget it advanced by a single message per request, so searching a long history never finished. One request now checks every remaining message and reads only the ones that contain the text, so a search with no hits over about 240,000 messages finishes in one request of about 1.5 seconds. Grouped (per-chat) search returns up to a full batch of chats per request instead of one. Matching is unchanged: literal, Unicode case-insensitive, with the same offsets, snippets and cursors.
