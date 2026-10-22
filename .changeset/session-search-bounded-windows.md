---
"@opengeni/db": patch
---

Session message search no longer fails on large histories. One database statement used to check every remaining message, so on a large real workspace it ran past the request's 5 second statement timeout and the search failed. Each statement now reads at most 2,000 messages in order, and a request keeps reading further windows for up to about 1.5 seconds before returning a cursor. Measured on a production workspace with about 240,000 messages, one window takes about 25 ms. A search with no hits still covers the whole history across a few requests, and common terms return at once. Matching, ordering, offsets, snippets, grouping and cursors are unchanged.
