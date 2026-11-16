---
"@opengeni/db": patch
---

Migration 1479 grants the runtime EXECUTE on the organization-wide sandbox counts that 1475 created withheld, so the per-organization, per-member and running-box plan limits apply at admission. Readiness now requires the grant. It must reach production only in a release after the one that contains 1475: the previous binary rejects an unknown granted definer.
