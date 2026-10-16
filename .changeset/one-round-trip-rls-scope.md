---
"@opengeni/db": patch
---

Scoped database work makes fewer round trips to PostgreSQL. Each tenant-scoped transaction used to look up the workspace's account, then set the tenant, subject and actor settings, read them back and take its advisory locks in separate statements, about nine sequential round trips for a single read. One statement now resolves the account, applies every setting, takes the locks in the same order and reads the result back, so a standalone scoped read is BEGIN, setup, query and COMMIT. Isolation, lock order, nested-scope restore and the fail-loud checks are unchanged.
