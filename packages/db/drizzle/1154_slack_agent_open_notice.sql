-- deployment-mode: rolling
-- Open Slack agents: the first time someone outside an agent's workspace asks
-- it, its first message says their messages are visible to that workspace's
-- members. Claimed once per person and agent, like the "next time" hint: the
-- chat that claims it shows it, and a repair of that chat renders the same
-- bytes. A new nullable column the previous release never reads or writes.
ALTER TABLE slack_agent_user_states ADD COLUMN IF NOT EXISTS open_notice_interaction_id uuid;
