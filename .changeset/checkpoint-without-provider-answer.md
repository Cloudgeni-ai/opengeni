---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
---

A context checkpoint that failed before any provider answer, including one refused because the sandbox moved to another machine just before it was sent, now retries the same turn instead of failing it. When a checkpoint does fail for good, a goal's continuation reports `blocked` with the new reason `compaction_failed`, and the goal pill says a message or Compact continues it, rather than claiming the goal will continue automatically.
