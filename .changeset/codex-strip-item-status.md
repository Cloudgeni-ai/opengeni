---
"@opengeni/codex": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
---

Omit Responses output-only item `status` when persisting conversation history, and omit opaque `encrypted_content` from the portable compaction temporary copy, so SuperGrok-origin portable sessions can continue and compact on Codex. Keep the Codex wire strip as defense for already-stored rows and mid-turn SDK items. Durable history is not rewritten on a model switch.
