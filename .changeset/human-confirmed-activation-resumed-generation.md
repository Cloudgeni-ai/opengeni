---
"@opengeni/db": patch
---

Fix human-confirmed `remember_confirm` activation after the human-input resume:
the live attempt of the same logical turn is now accepted at the asked
generation or later (migration 0315) for both governed-learning activation and
knowledge-claim confirmation, while the human answer stays bound to the exact
generation in which the question was asked.
