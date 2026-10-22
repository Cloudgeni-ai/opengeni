---
"@opengeni/db": patch
---

Session message search now uses a trigram index, so a search reads only the messages that can contain the text instead of walking the whole history. Row-level security used to stop PostgreSQL from using any text index for this search. Message text now also lives in a read-only table whose row-security policy is the search pattern, which lets the index serve it under the same workspace and visibility rules. A trigger fills it for new messages, and a batched migration copies existing history. On a copy of a 234,000-message workspace, one window takes about 2 ms for a rare word and 15 to 50 ms for common ones. `scannedMessages` now counts only the candidate messages read. Migrations install the `pg_trgm` and `btree_gin` extensions; managed PostgreSQL services with an extension allowlist (such as Azure's `azure.extensions`) must allow them first.
