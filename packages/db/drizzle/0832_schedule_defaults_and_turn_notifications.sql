-- deployment-mode: rolling
-- Keep normal session selection intent and notify the human of the calling turn.
-- Accepted executions and historical model context are not rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $projection$
DECLARE
  definition text;
  anchor text := $old$    IF v_recipient IS NULL THEN
      RETURN NULL;
    END IF;

    CASE NEW.type$old$;
  replacement text := $new$    IF NEW.type IN ('session.notification.posted', 'session.notification.withdrawn')
      AND NEW.turn_id IS NOT NULL THEN
      SELECT opengeni_private.session_person_v1(NEW.workspace_id, NULL,
        turn.initiating_human_subject_id, turn.initiating_human_subject_id)
      INTO v_recipient FROM session_turns turn
      WHERE turn.id = NEW.turn_id AND turn.session_id = NEW.session_id
        AND turn.workspace_id = NEW.workspace_id;
    END IF;
    IF v_recipient IS NULL THEN
      RETURN NULL;
    END IF;

    CASE NEW.type$new$;
BEGIN
  definition := pg_get_functiondef('opengeni_private.project_inbox_for_session_event_v1()'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'inbox notification recipient anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $projection$;

DO $creation$
DECLARE
  definition text;
  anchor text := $old$OR session_row.tool_policy IS DISTINCT FROM
          '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb$old$;
  replacement text := $new$OR session_row.tool_policy IS DISTINCT FROM coalesce(
          generated_binding -> 'toolPolicy',
          '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb)$new$;
BEGIN
  definition := pg_get_functiondef('fence_scheduled_task_run_connection_session_identity()'::regprocedure);
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'scheduled generated tool policy anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $creation$;

-- The server-stamped creator identifies the source of an old materialized list.
-- Require positive default intent with no later policy edit; unknown/explicit
-- creators and explicit empty selections remain untouched. Take tenancy fences
-- before the migration owner's transaction-local FORCE-RLS window.
SET LOCAL opengeni.session_variable_set_attachments_v1 = '1';
CREATE TEMP TABLE schedule_default_workspaces (workspace_id uuid PRIMARY KEY) ON COMMIT DROP;
DO $fences$
DECLARE inventory_id uuid; workspace_value uuid;
BEGIN
  inventory_id := opengeni_private.open_session_tenancy_fence_inventory(session_tenancy_fence_target_schema());
  INSERT INTO pg_temp.schedule_default_workspaces SELECT DISTINCT workspace_id FROM scheduled_tasks;
  FOR workspace_value IN SELECT workspace_id FROM pg_temp.schedule_default_workspaces ORDER BY workspace_id LOOP
    PERFORM acquire_session_tenancy_fence(workspace_value);
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(inventory_id);
  RAISE;
END $fences$;

ALTER TABLE scheduled_tasks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE session_events NO FORCE ROW LEVEL SECURITY;

CREATE TEMP TABLE schedule_default_repairs ON COMMIT DROP AS
SELECT task.id, task.account_id, task.workspace_id, task.authority_revision,
  task.reusable_session_id, task.creator_first_party_mcp_tools
FROM scheduled_tasks task JOIN sessions creator
  ON creator.id::text = task.created_by_context #>> '{via,-1,sessionId}'
  AND creator.workspace_id = task.workspace_id AND creator.account_id = task.account_id
WHERE task.workspace_id IN (SELECT workspace_id FROM pg_temp.schedule_default_workspaces)
  AND task.created_by_context #>> '{via,-1,kind}' = 'agent'
  AND creator.tool_policy ->> 'firstPartyMode' = 'workspace_default'
  AND task.creator_first_party_mcp_tools IS NOT NULL
  AND task.creator_first_party_mcp_tools <> '[]'::jsonb
  AND task.deleted_at IS NULL
  AND (creator.tool_policy_version = 1 OR EXISTS (
    SELECT 1 FROM session_events event
    WHERE event.workspace_id = creator.workspace_id AND event.session_id = creator.id
      AND event.type = 'session.tool_policy.updated' AND event.created_at <= task.created_at
  ))
  AND NOT EXISTS (
    SELECT 1 FROM session_events event
    WHERE event.workspace_id = creator.workspace_id AND event.session_id = creator.id
      AND event.type = 'session.tool_policy.updated' AND event.created_at > task.created_at
  );

-- Only an untouched generated reusable chat inherits the repaired intent.
-- A person's later edit to that chat remains authoritative.
UPDATE sessions session
SET tool_policy = session.tool_policy || '{"firstPartyMode":"workspace_default"}'::jsonb,
    tool_policy_version = session.tool_policy_version + 1
FROM pg_temp.schedule_default_repairs repair
WHERE session.id = repair.reusable_session_id AND session.workspace_id = repair.workspace_id
  AND session.created_by_subject_id = 'scheduler'
  AND session.metadata ->> 'scheduledTaskId' = repair.id::text
  AND session.tool_policy = '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb
  AND session.tool_policy_version = 1
  AND session.first_party_mcp_tools = repair.creator_first_party_mcp_tools;

-- Advance the task through the existing revision-copy path, retaining all old
-- accepted authority and every personal-resource/linked-identity restriction.
DO $revisions$
DECLARE repair record; provider text;
BEGIN
  FOR repair IN SELECT * FROM pg_temp.schedule_default_repairs ORDER BY id LOOP
    PERFORM set_config('opengeni.account_id', repair.account_id::text, true);
    PERFORM set_config('opengeni.workspace_id', repair.workspace_id::text, true);
    UPDATE scheduled_tasks SET creator_first_party_mcp_tools = NULL,
      authority_revision = repair.authority_revision + 1
    WHERE id = repair.id AND workspace_id = repair.workspace_id;
    PERFORM clone_scheduled_task_personal_resource_authority(
      repair.account_id, repair.workspace_id, repair.id, repair.authority_revision, repair.authority_revision + 1);
    PERFORM clone_scheduled_task_revision_authority(
      repair.account_id, repair.workspace_id, repair.id, repair.authority_revision, repair.authority_revision + 1);
    FOREACH provider IN ARRAY opengeni_private.subscription_authority_compat_providers() LOOP
      PERFORM opengeni_private.copy_subscription_authority_compat(
        provider, 'scheduled_task_revision', repair.workspace_id, repair.id, repair.authority_revision + 1);
    END LOOP;
    INSERT INTO external_link_task_authorities
      (task_id, task_revision, account_id, workspace_id, link_id, link_revision, canonical_snapshot)
    SELECT task_id, repair.authority_revision + 1, account_id, workspace_id, link_id, link_revision, canonical_snapshot
    FROM external_link_task_authorities WHERE task_id = repair.id
      AND task_revision = repair.authority_revision AND workspace_id = repair.workspace_id;
  END LOOP;
END $revisions$;

ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE scheduled_tasks FORCE ROW LEVEL SECURITY;
