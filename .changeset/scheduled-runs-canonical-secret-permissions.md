---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Schedules that start a new chat per run and were saved before the secret permission names were unified run again. Every run of such a schedule was refused with `scheduled_run_authority_proof_rejected`, because its chat stored the current permission names while the run still named the retired ones. A run now names the same canonical permissions as the chat it creates.
