-- deployment-mode: rolling
-- Connected agents (coding agents on someone's computer, connected to the
-- organization MCP server) get named tools (docs/mcp-surfaces.md):
--
-- 1. organization_mcp_connection_settings: one row per connected agent (its
--    refresh family id): the workspace its tools use when a call names none,
--    and what it may do with app data. Viewer is the default; only the person
--    who connected it, in a browser, makes it a manager. No row means viewer
--    and no default workspace. Never authority by itself: every call still
--    runs the real route as the person, capped by the connection's access.
--    No foreign key to workspaces: a deleted or unreachable default is
--    ignored when it's read, and the table never locks workspaces.
-- 2. skill_apply_lifecycle: a person's save that asks to follow Agent
--    learning (`learningPolicy: "follow"`, sent for Skills a connected agent
--    uploads) gets the mode Agent learning gives that destination, as an
--    agent's save does: Review first leaves it pending for review, Off
--    refuses it. Every other save is unchanged.
--
-- Rolling: a new table the previous release never reads or writes, and a
-- function change that only reacts to a request field the previous release
-- never sends.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_mcp_connection_settings (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  subject_id text NOT NULL,
  default_workspace_id uuid,
  app_data_access text NOT NULL DEFAULT 'viewer',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, connection_id),
  CONSTRAINT organization_mcp_connection_settings_bounds_check
    CHECK (app_data_access IN ('viewer', 'manager') AND length(subject_id) BETWEEN 1 AND 512)
);
COMMENT ON TABLE organization_mcp_connection_settings IS 'A connected agent''s default workspace and app data reach; never authority by itself.';

ALTER TABLE organization_mcp_connection_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mcp_connection_settings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_mcp_connection_settings FROM PUBLIC;
CREATE POLICY account_isolation ON organization_mcp_connection_settings
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $opengeni_mcp_connection_settings_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON organization_mcp_connection_settings FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_mcp_connection_settings TO opengeni_app;
  END IF;
END
$opengeni_mcp_connection_settings_grants$;

DO $outside_agent_skill_learning$
DECLARE definition text; anchor text;
BEGIN
  definition := pg_get_functiondef(format(
    '%I.skill_apply_lifecycle(uuid,uuid,jsonb,jsonb)', current_schema())::regprocedure);
  anchor := $a$  IF original_operation='confirm_response' THEN mode := 'automatic'; END IF;
$a$;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'skill_apply_lifecycle confirm_response anchor drifted';
  END IF;
  definition := replace(definition, anchor, $r$  IF p_actor->>'kind'='human' AND operation='save' AND p_request->>'learningPolicy'='follow' THEN
    learning_policy:=knowledge_learning_resolve(p_account_id,p_workspace_id,
      CASE WHEN scope='user' THEN actor_subject END,'defaults',transaction_timestamp());
    mode:=coalesce(learning_policy#>>'{effective,skills}','review_first');
    IF mode='review_first' THEN mode:='suggest'; END IF;
    IF mode = 'off' THEN RAISE EXCEPTION 'Learning is Off; durable Skill changes are refused' USING ERRCODE='42501'; END IF;
  END IF;
$r$ || anchor);
  EXECUTE definition;
END
$outside_agent_skill_learning$;
