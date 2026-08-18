---
"@opengeni/db": patch
---

Test-only: add cross-organization isolation and revocation evidence coverage for the organization-tenancy authority tables. `packages/db/test/organization-isolation-evidence.test.ts` proves, against a real PostgreSQL instance, that a member of one organization cannot read or mutate another organization's workspaces, sessions, or resources, and that revoking a membership takes effect immediately for the exact revoked grant. No shipped runtime behavior changes; this releases the new coverage with the package.
