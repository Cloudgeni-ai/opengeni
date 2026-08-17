---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

`remember` with `lane: knowledge` now returns `confirmation_required` bound to the Knowledge claim, and `remember_confirm` (`claimId`) approves the claim through the Knowledge review lifecycle after the exact initiating human answered the bound canonical question with `save` (rolling migration 0273, `confirm_remember_knowledge_claim`, immutable `remember_knowledge_confirmation_receipts`). `remember_confirm` accepts either `proposalId` + `decisionReceiptId` (preference / instruction policy) or `claimId` (knowledge); the confirm receipt carries `claimId` and a `knowledge` activation summary with `undo: knowledge_review`.
