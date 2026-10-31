---
"@opengeni/contracts": patch
---

Inline `agentConfig.skills` on a scheduled task that starts its own chats now count against the same Skill limits as session create, instead of the 128 KiB agent config cap. A task can carry the same Skills a session create takes; the rest of its agent config keeps the 128 KiB cap, and a run's accepted execution no longer counts the task's Skills against its 512 KiB cap.
