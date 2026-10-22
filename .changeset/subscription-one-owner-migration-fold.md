---
"@opengeni/db": patch
---

Migration 0907 (one owner per subscription account) now finishes in seconds on large databases instead of timing out, and gives up after five seconds if it cannot take its locks, so readers never queue behind it for longer. A disconnected account that a workspace still managed while it reached other workspaces no longer stops the migration; it becomes the organization's. The end state is otherwise unchanged.
