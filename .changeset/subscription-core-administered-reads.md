---
"@opengeni/db": patch
---

Add provider-neutral live usage reads for subscription accounts outside a workspace pool: an organization administrator can read an organization account's usage, and a person can read their own personal account's usage from their Personal workspace, through new owner-only database routines. No provider uses them yet, so behaviour is unchanged.
