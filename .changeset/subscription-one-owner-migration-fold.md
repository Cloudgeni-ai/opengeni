---
"@opengeni/db": patch
---

Migration 0907 (one owner per subscription account) now finishes in seconds on large databases instead of timing out. It waits at most five seconds for its locks; once it has them it holds them while it folds, so reads and writes of subscription accounts wait for those seconds too. A disconnected account that a workspace still managed while it reached other workspaces no longer stops the migration; it becomes the organization's. The end state is otherwise unchanged.
