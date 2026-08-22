---
"@opengeni/db": patch
---

Fix human-confirmed `remember_confirm` activation after the human-input resume
(migration 0315): the human answer is bound to the same logical turn and exact
proposal rather than one execution generation, so the answered request row and
the live attempt may both carry a later generation of that turn than the
decision receipt, for both governed-learning activation and knowledge-claim
confirmation.
