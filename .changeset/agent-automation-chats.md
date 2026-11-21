---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/sdk": patch
---

An agent's automation can now keep one chat (`reusable_session`) or post into an existing chat (`existing_session`), not only start a new chat each run. Its own chat is started with the agent; when the automation's agent changes, the chat is cleared so the next run starts a new one with the new agent, the task records the previous chat under `SCHEDULED_TASK_AGENT_CHAT_CHANGE_METADATA_KEY` with the audit event `scheduled_task.agent_chat_changed`, and the automation form says so. An existing chat must be bound to the same agent and usable by the owner; otherwise saving returns 422 "That chat isn't with this agent", and the form marks other chats "Not a chat with this agent". Agent access checks and event limits are unchanged.
