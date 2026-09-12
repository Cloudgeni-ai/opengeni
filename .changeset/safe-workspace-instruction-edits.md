---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Make agent-authored workspace instruction changes non-destructive: append new rules by default, require one exact anchor for edits or removals, and reserve complete replacement for an explicit mode while preserving baseline conflict checks and instruction budgets.
