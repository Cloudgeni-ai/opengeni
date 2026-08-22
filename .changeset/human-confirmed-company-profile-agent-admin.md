---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

Add an explicit organization-owner-confirmed agent path for company-profile and
strategic-goal administration. The two-step MCP flow stages an immutable inactive
full-profile proposal, binds activation to the initiating human's exact
structured confirmation, revalidates current organization authority and profile
CAS in PostgreSQL under the canonical workspace/session lock order, and remains
independent of workspace learning mode. The manual `account:admin` route keeps
its admission contract, and the earlier proposal-only `company_profile_propose`
tool (`durable_learning` provenance) is retired in favor of this path.
