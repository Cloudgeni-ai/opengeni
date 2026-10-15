---
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Scheduled tasks that start a new agent on an organization Claude subscription model run again. Their fresh-run admission did not pass the task's accepted Claude authority, so the model was always refused and the run was rolled back, leaving no run, no session and no visible failure. The scheduler now admits the model against the task's accepted authority as the person accountable for the task. A refused model is recorded as a visible run with its reason instead of vanishing. Every custom-model admission now states its Claude authority explicitly, so an omitted authority can no longer refuse a model silently.
