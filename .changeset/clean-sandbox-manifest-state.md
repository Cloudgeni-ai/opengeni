---
"@opengeni/runtime": patch
---

Persist sandbox session state without the redundant hydrated provider manifest when the canonical serialized manifest is already present, so durable turn reconciliation remains JSON-safe.
