---
"@opengeni/db": patch
---

Archiving a very long idle session no longer slows down page by page. The export reads under row-level security, where PostgreSQL only uses leakproof comparisons as index conditions. Numeric and row comparisons are not leakproof, so every page of model history re-filtered all earlier rows (3.8 seconds per 200 rows at row 40,000 on staging), and the largest sessions ran past the archive activity limit. Keyset cursors now compare column by column on leakproof key types, and model history reads its ordered row ids once and then fetches each page by primary key: about 5 seconds for the id list plus 60 ms per page for a 52,000-item session. No migration is needed.
