---
"@opengeni/browserd": patch
---

When a browser action becomes `outcome_unknown` because a later step failed, the receipt now keeps that step's reason (for example "browser element is covered or not pointer-actionable"), not only its error code, so agents can correct the target without replaying.
