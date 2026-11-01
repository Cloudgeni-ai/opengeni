---
"@opengeni/db": patch
---

A scheduled task that starts its own chats and sets `agentConfig.bundledSkillIds` (including an empty list) now runs. Before, every run of such a task, scheduled or started with Run now, failed with `scheduled_run_authority_proof_rejected`: the chat stores the task's bundled Skill selection, and the database check that compares each generated chat with its accepted run did not expect it. That check now requires exactly the task's selection. Tasks without a selection are unchanged.
