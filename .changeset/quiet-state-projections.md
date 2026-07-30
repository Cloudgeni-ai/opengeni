---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/documents": patch
"@opengeni/sdk": patch
---

Add the read-only Workspace State inventory with bounded, authorization-scoped
Documents aggregates and a deterministic metadata-only Memory projection. The
projection explicitly labels legacy `knowledge_memories` preference-kind counts
as non-authoritative observations while preserving the structured preference
registry as the sole active preference authority.