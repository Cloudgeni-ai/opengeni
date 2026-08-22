---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Add an explicit organization owner/admin-confirmed agent path for company-profile
and strategic-goal administration. The two-step MCP flow stages an immutable
inactive full-profile proposal, binds activation to the initiating human's exact
structured confirmation, revalidates current organization authority and profile
CAS in PostgreSQL, and remains independent of workspace learning mode.