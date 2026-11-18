---
"@opengeni/db": patch
---

An unpaid person's second and later additional organizations created within 24 hours of their first organization start held (rule `additional-organization-v1`, migration 1491). The first additional organization and people with a paying organization are unaffected. A detector hold on an additional organization restricts only that organization: it doesn't follow the person to their other organizations (no linked restriction or linked-owner hold). A manual denial still does.
