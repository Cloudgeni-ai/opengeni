---
"@opengeni/db": patch
---

Migration 1499 grants the runtime EXECUTE on the Nango in-use check (1482) and the live Nango connection owners listing (1487), which both shipped withheld. Deleting a Nango connection is then decided from every non-revoked row that names it, and the Nango sweep also visits a person whose only connection is gone. Readiness now requires both grants. Migration 1500 validates `connections_account_identity_key_check`, which 1480 added `NOT VALID`. These must reach production only in a release after the one that contains 1487: the previous binary rejects an unknown granted definer.
