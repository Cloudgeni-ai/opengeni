---
"@opengeni/db": patch
---

Row policies skip the owner-only capability checks when the caller isn't the table owner, so reads that pass over other tenants' rows no longer run them on every row.
