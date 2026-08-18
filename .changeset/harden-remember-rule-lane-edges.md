---
"@opengeni/core": patch
"@opengeni/db": patch
---

Harden the four `remember` instruction-policy edges.

A moved policy head is now one typed, actionable `RememberError` (`baseline_stale`) on both the propose and confirm sides instead of an untyped error or a raw SQLSTATE 40001. The activation baseline no longer contributes to operation identity, so an ordinary turn-recovery replay of the same `operationId` stays idempotent across a head change; staleness is still enforced by the compare-and-set and by the activation function. A governed write that fails now archives the evidence task note it created instead of stranding it.

A confirmation stranded by a head that moved after the human already answered now rebaselines onto the current head and completes, instead of hard-failing and forcing the human to answer again. Proposal uniqueness moves from one-per-source to one-per-source-per-baseline to admit that successor; the successor reuses the same knowledge proposal, so the human's confirmation stays bound to exactly the content they approved.

Two consequences worth stating plainly:

- Activating a rule replaces the whole active policy document, so confirming a second rule discards a first rule that a human also approved, without asking again. That is the existing whole-document-replacement design of this lane rather than something the rebaseline introduces - previously the stale baseline forced a round trip that would have clobbered anyway - and the audit trail stays exact, with the activation event naming the revision it replaced and `undo` restoring it. The rebaseline removes the round trip, which makes the behaviour easier to reach.
- Excluding the baseline from operation identity changes both the proposal request fingerprint and the governed-write input hash (which derives the service actor subject id). A `remember` operation that durably wrote rows under the previous release and is replayed under this one computes a different identity and fails as an operation-reuse conflict. This is bounded to operations in flight across the deploy and self-heals with a fresh operation id; no dual-identity compatibility path was added.
