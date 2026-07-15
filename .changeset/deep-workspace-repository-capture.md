---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

Discover repositories at any workspace nesting depth, including linked worktrees whose `.git` marker is a file, while pruning dependency/build residue and enforcing timeout and repository-count bounds. An incomplete discovery now persists an epoch-fenced degraded capture revision, announces its typed reason, and makes clients prefer live workspace data instead of presenting a misleading empty capture.
