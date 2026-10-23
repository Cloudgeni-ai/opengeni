---
"@opengeni/contracts": patch
---

Reuse common eager primitive validators to reduce schema construction and retained memory. Validation and JSON Schema output remain unchanged. Field-specific metadata should be attached to a derived schema, rather than mutating the registry entry of a shared primitive.
