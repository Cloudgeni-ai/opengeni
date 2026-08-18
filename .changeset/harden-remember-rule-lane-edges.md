---
"@opengeni/core": patch
"@opengeni/db": patch
---

Harden three `remember` instruction-policy edges: a moved policy head is now one typed, actionable `RememberError` (`baseline_stale`) on both the propose and confirm sides instead of an untyped error or a raw SQLSTATE 40001; the activation baseline no longer contributes to operation identity, so an ordinary turn-recovery replay of the same `operationId` stays idempotent across a head change; and a governed write that fails now archives the evidence task note it created instead of stranding it for its full lifetime.
