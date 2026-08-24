---
"@opengeni/db": minor
---

Add the bounded organization connection-authority convergence seam to the `@opengeni/db` public surface: `classifyOrganizationConnectionAuthority` and `backfillOrganizationConnectionAuthority`, plus their `ConnectionAuthorityClassificationReport` / `ConnectionAuthorityBackfillReport` types, and the durable `runKey` receipt option on the organization membership backfill drain.

Connection owner authority now binds through one owner-only seam that works under the production database posture. `organization_memberships` and `organization_user_resource_authorities` are `FORCE ROW LEVEL SECURITY` and OpenGeni runs its SECURITY DEFINER routines as a non-superuser owner without `BYPASSRLS`, so the previous inline `SELECT ... FOR SHARE` plus authority insert matched nothing: a new personal connection whose subject held a live organization membership silently degraded to the `legacy_user` lane, and the bounded `legacy_user` upgrader refused every deterministic candidate.
