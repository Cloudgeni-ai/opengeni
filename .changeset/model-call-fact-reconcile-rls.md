---
"@opengeni/db": patch
---

The background job that repairs missing per-call usage facts no longer runs for seconds per workspace and loads the database. Its lookup of existing facts now uses the full unique index under row-level security, about 50 times faster on a busy workspace.
