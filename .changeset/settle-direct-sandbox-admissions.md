---
"@opengeni/db": patch
---

Settle abandoned null-outcome direct sandbox mutation admissions when their physically completed request holder is released, preventing a failed settlement callback from blocking workspace checkpoint capture indefinitely. Require an exact physical-quiescence receipt before re-admitting a turn after graceful worker or provider recovery, and reconcile pre-fix attempts from their durable recovery event plus Temporal activity proof.
