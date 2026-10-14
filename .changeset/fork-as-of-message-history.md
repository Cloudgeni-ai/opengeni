---
"@opengeni/db": minor
"@opengeni/worker-bundle": patch
---

Forking a chat at a message from before a later compaction or context clear now works. The fork gets the history the model had when that message was written, instead of being refused. Every context reset deactivates all rows and appends its new segment after them, so the live history at a message is the latest segment starting at or before it, through the message. Superseded rows stay retained and are copied back as live rows. Rolling migration 0778 rewrites `fork_session_content` to find that segment:

- for a clear, from its marker position;
- for a compaction, from its new `replacementFromPosition` receipt field, which compaction now records;
- for older compaction receipts, from the replacement rows written in the summary's own transaction.

A user message's boundary is its turn's first user row, never a later user row or summary from the same turn. The fork fails closed whenever the retained rows can't prove that history.
