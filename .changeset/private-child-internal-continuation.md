---
"@opengeni/db": patch
---

Allow an authorized private-session internal-update attempt to create a same-owner
private child while preserving service audit attribution and the existing causal
human, ownership, attempt and interruption checks.

Rolling migration 0654 binds insert attribution to the capability's recorded
parent turn instead of requiring a human audit initiator.
