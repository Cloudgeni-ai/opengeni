---
"@opengeni/runtime": patch
---

Preserve prompt-cache reuse across turns with unchanged governance by keeping attempt-specific snapshot receipt UUIDs out of system instructions. Stable content hashes, policy revisions, and skill retrieval handles remain model-visible; exact-attempt snapshot IDs remain in durable audit records.
