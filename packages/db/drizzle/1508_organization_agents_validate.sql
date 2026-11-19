-- deployment-mode: rolling
-- Validates the checks 1504 added NOT VALID. They have been enforced on every
-- write since 1504, and every older row satisfies them (new columns are NULL
-- or default, the widened checks accept every older value). VALIDATE
-- CONSTRAINT takes only SHARE UPDATE EXCLUSIVE: reads and writes continue
-- while it scans. sessions_agent_version_check stays NOT VALID like
-- sessions_agent_prompt_revision_check (1244): validating would scan every
-- chat for a check that only new rows can break.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE agents VALIDATE CONSTRAINT agents_scope_check;
ALTER TABLE agents VALIDATE CONSTRAINT agents_organization_fields_check;
ALTER TABLE agent_revisions VALIDATE CONSTRAINT agent_revisions_organization_fields_check;
ALTER TABLE organization_managed_workspaces VALIDATE CONSTRAINT organization_managed_workspaces_source_check;
ALTER TABLE organization_console_audit_events VALIDATE CONSTRAINT organization_console_audit_events_action_check;
