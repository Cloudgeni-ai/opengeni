---
"@opengeni/worker-bundle": patch
---

Automations that run an agent with Memory on start their chat again. The agent's Memory guidance is now part of the run's accepted instructions, so the chat is no longer refused with "scheduled_run_authority_proof_rejected".
