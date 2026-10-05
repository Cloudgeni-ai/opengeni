---
"@opengeni/core": patch
---

Model admission and workspace catalog resolution read workspace connection metadata, workspace custom models, and organization provider readiness and models with one scoped read per family instead of one per provider. Session creation issues about 20% fewer database statements and transactions.
