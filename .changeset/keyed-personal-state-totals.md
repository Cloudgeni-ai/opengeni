---
"@opengeni/db": patch
---

Use keyed personal-state reads for session-list totals, with a concurrent session-first index. Generic prepared plans no longer repeatedly scan a large workspace's personal-state range when most other workspaces are small. List contents, permissions and transaction behavior are unchanged.
