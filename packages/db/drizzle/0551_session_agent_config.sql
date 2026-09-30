-- deployment-mode: rolling
-- One frozen agent configuration per session (capabilities, identity,
-- renderer; see packages/contracts/src/agent-config.ts). NULL, which every
-- existing row keeps and every legacy create writes, means the historical
-- behavior with byte-identical tools and prompt. Additive and nullable, so
-- older API and worker images ignore it; the API only writes non-null values
-- behind OPENGENI_AGENT_CONFIG_ADMISSION_ENABLED (or the default-for-new-
-- sessions switch) after every worker understands the column. Mid-session
-- updates reuse the tool_policy_version compare-and-swap.
ALTER TABLE sessions ADD COLUMN agent_config jsonb;
