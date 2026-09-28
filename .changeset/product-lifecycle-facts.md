---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

Add per-person product lifecycle facts to the durable host export as a third kind, `lifecycle_fact`. Migration `0532_product_lifecycle_fact_export.sql` (rolling) captures one content-free fact per sign-up, email verification, sign-in, organization setup, model connection, credit top-up, connection, scheduled task, installed catalog Skill, Slack user link, enrolled machine and organization join, in the same transaction as the product change. Nothing is captured until a host registers a `lifecycle_fact` consumer, and a capture failure never fails the product change.

Every fact is a fixed type with an optional value from a fixed per-type list (`PRODUCT_LIFECYCLE_FACT_ATTRIBUTES`), a subject kind, the opaque `user:`/`api_key:` subject id when there is one, and the organization and workspace UUIDs when the product change has them. Sign-up, verification and sign-in facts carry no organization. `claimHostExportBatch` accepts `kind: "lifecycle_fact"` and returns a `HostLifecycleFactExportBatch`; `createHostExportPump` accepts an optional `lifecycleSink`.
