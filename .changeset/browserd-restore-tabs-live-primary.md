---
"@opengeni/browserd": patch
---

Restoring a checkpointed tab set now keeps the live tab that startup selected for the primary page instead of re-selecting a reopened tab with the same URL whose renderer crashed, so resume no longer fails with "This browser tab crashed".
