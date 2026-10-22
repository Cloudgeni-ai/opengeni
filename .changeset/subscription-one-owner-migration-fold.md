---
"@opengeni/db": patch
---

Migration 0907 (one owner per subscription account) now finishes in seconds on large databases instead of timing out, and is now a maintenance migration: releases park database clients while it runs, because it locks the subscription tables for the whole fold (about six seconds at 30,000 accounts and 100,000 workspaces). It waits at most five seconds to take each set of locks; that bounds only the wait, not how long it then holds them. A disconnected account that a workspace still managed while it reached other workspaces no longer stops the migration; it becomes the organization's. The end state is otherwise unchanged.
