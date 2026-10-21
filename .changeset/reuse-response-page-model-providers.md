---
"@opengeni/core": patch
---

Resolve model metadata once per distinct model in a session response page instead of reparsing the provider registry for every row. Reuse is limited to the page's freshly loaded catalog context; session responses, permissions, and subsequent-request freshness are unchanged.
