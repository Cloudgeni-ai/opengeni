---
"@opengeni/contracts": minor
---

Reuse common eager primitive validators to reduce schema construction and retained memory. Validation and the application's default JSON Schema serialization remain unchanged. Primitive object identities are now shared: field-specific metadata should be attached to a derived schema, rather than mutating the registry entry of a shared primitive. Consumers explicitly using Zod's `reused: "ref"` option may receive shared `$defs` references instead of repeated inline primitive schemas.
