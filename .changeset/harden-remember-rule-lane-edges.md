---
"@opengeni/core": patch
"@opengeni/db": patch
---

Harden the four `remember` instruction-policy edges. A moved policy head is now one typed, actionable `RememberError` (`baseline_stale`) on both the propose and confirm sides instead of an untyped error or a raw SQLSTATE 40001. The activation baseline no longer contributes to operation identity, so an ordinary turn-recovery replay of the same `operationId` stays idempotent across a head change. A confirmation stranded by a head that moved after the human already answered now rebaselines onto the current head and completes, instead of hard-failing and forcing the human to answer again; proposal uniqueness moves from one-per-source to one-per-source-per-baseline to admit that successor. A governed write that fails now archives the evidence task note it created instead of stranding it.
