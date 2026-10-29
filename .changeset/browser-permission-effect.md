---
"@opengeni/browserd": patch
---

A `permission` browser action that set the permission and then lost its tab (a refused reattach or a tab that stopped answering) is now reported as `outcome_unknown` instead of `failed`, because the permission may already be set. The browser's own refusal of a setting is still reported as `failed`.
