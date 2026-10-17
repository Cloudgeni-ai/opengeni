---
"@opengeni/db": patch
---

Archiving a very long idle session no longer slows down page by page. The export read each page under row-level security, where PostgreSQL cannot use a numeric or row comparison as an index condition, so every page of model history re-filtered all earlier rows (3.8 seconds per 200 rows at row 40,000) and the largest sessions ran past the archive activity limit. Pages are now read by an archive-only database function on a unique, indexed key, so each page is an index seek. It refuses a session that is not being archived instead of returning an empty page.
