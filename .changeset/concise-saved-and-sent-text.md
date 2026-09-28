---
"@opengeni/contracts": minor
"@opengeni/runtime": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Text an agent saves or sends for others is short and sized to the request by default. The operational contract now covers Skills, workspace instructions, scheduled-task prompts, and messages to people or channels, and asks for Slack formatting in text sent to Slack through a tool. `skill_save` and `skill_publish` state a sizing rule (`AGENT_AUTHORED_SKILL_STYLE`), the bundled `opengeni-skills` guide shows a preference-sized example, and an agent-written Skill description is capped at 300 characters (`AGENT_AUTHORED_SKILL_DESCRIPTION_MAX_CHARS`) unless it is unchanged from the base revision. `scheduled_tasks_create` and `scheduled_tasks_update` ask for a short prompt and declare real `schedule` and `agentConfig` input shapes. New Slack task sessions are told that the final reply is posted as written and is cut off at 3,500 characters, and repository Skill guidance no longer asks the agent to announce which Skills it uses. The deprecated `AGENT_AUTHORED_DURABLE_TEXT_STYLE` export is removed; use `AGENT_AUTHORED_INSTRUCTION_POLICY_STYLE` or `AGENT_AUTHORED_SKILL_STYLE`.
