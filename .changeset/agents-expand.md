---
"@opengeni/db": patch
---

Adds the `agents`, `agent_revisions` and `agent_slack_installs` tables and the `sessions.agent_id` and `agent_prompt_revision` columns. Existing Slack agents and bot templates are copied into them and kept in sync by triggers. Nothing reads the new tables yet, so behaviour is unchanged.
