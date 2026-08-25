---
"@opengeni/db": patch
---

Fence both Slack routing tenancy probes on the organization the caller is acting for, and apply the canonical live-authority rule to the membership arm of `resolveSlackTargetAuthority`, so a suspended organization member holding a stale `workspace_memberships` row is no longer granted. The two arbitrary-subject Slack resolvers are renamed to the repository's `namedSubject*` convention and carry the oracle banner.
