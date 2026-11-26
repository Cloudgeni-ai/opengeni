---
"@opengeni/runtime": patch
"@opengeni/observability": patch
---

A Modal workspace that holds hardlinked files (for example a package manager's cache hardlinked into `node_modules`) now saves: the streamed Modal capture stores files that share an inode as separate regular files, as the other backends already do, instead of hardlink members that the archive check refuses on every retry. Failed workspace saves and restores now also log a closed classification: the sandbox error name, its integrity code, the archive check's reason class (`archiveReason`) and, when the archive command in the box fails, its exit code. Member paths and command output are never logged.
