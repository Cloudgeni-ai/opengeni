-- deployment-mode: rolling
-- The built-in meeting summary (docs/recordings.md, "Built-in summary") is an Only me
-- chat for the owner of an Only me meeting, started by Opengeni's
-- meeting-summary service rather than by the person. Like the scheduler's
-- Only me runs, a private create by this service is accepted only with its
-- proof: the chat is the meeting-summary role with no sandbox and exactly the
-- meeting_read and meeting_notes_save tools, and the meeting named in its
-- metadata is an Only me meeting owned by the person the private-create
-- capability was opened for. Every other private create is unchanged.
-- A summary chat also keeps that shape for its whole life: an update that
-- would widen its tools, Skills, resources, sandbox or machine, agent
-- configuration or variable sets, or move it to another meeting or role, is refused, and no
-- session MCP server can be added to it. A person's fork of one is an
-- ordinary chat and is not held. A later bulk UPDATE of these columns on
-- every session must therefore skip meeting-summary chats.
-- The previous release never creates such a session, so it is unaffected.
DO $migration$
DECLARE
  definition text;
  anchor text := $a$OR (NEW.created_by_kind='service' AND NEW.created_by_subject_id='scheduler' AND EXISTS ($a$;
BEGIN
  IF pg_catalog.to_regprocedure(pg_catalog.format(
    '%I.guard_session_authority_write()', pg_catalog.current_schema())) IS NULL THEN
    RAISE WARNING '1005: guard_session_authority_write() is missing; private meeting summaries stay refused';
    RETURN;
  END IF;
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.guard_session_authority_write()', pg_catalog.current_schema()
  )::regprocedure);
  IF strpos(definition, $a$NEW.created_by_subject_id='meeting-summary'$a$) > 0 THEN
    RETURN;
  END IF;
  -- Without the scheduler clause (a replay that withholds it) there is
  -- nothing to extend, and a private summary create stays refused.
  IF strpos(definition, anchor) = 0 THEN
    RAISE WARNING '1005: the scheduler clause is missing; private meeting summaries stay refused';
    RETURN;
  END IF;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '1005 meeting summary private create drift' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, anchor,
    $r$OR (NEW.created_by_kind='service' AND NEW.created_by_subject_id='meeting-summary'
              AND NEW.policy_role='meeting_summary' AND NEW.sandbox_backend='none'
              AND NEW.resources='[]'::jsonb AND NEW.skills='[]'::jsonb
              AND NEW.tools='[{"kind":"mcp","id":"opengeni"}]'::jsonb
              AND NEW.create_idempotency_key LIKE 'meeting-summary:%'
              AND NEW.first_party_mcp_tools @> '["meeting_read","meeting_notes_save"]'::jsonb
              AND jsonb_array_length(NEW.first_party_mcp_tools)=2
              AND EXISTS (
              SELECT 1 FROM recordings meeting WHERE meeting.account_id=NEW.account_id
                AND meeting.workspace_id=NEW.workspace_id
                AND meeting.id::text=NEW.metadata->>'meetingSummaryRecordingId'
                AND meeting.purpose='meeting' AND meeting.visibility='user_private'
                AND meeting.owner_subject_id=capability.actor_subject_id))
            $r$ || anchor);
  EXECUTE definition;
END
$migration$;

CREATE OR REPLACE FUNCTION guard_meeting_summary_session_shape() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_TABLE_NAME = 'session_mcp_servers' THEN
    IF EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id=NEW.workspace_id
        AND s.id=NEW.session_id AND s.policy_role='meeting_summary'
        AND s.created_by_kind='service' AND s.created_by_subject_id='meeting-summary') THEN
      RAISE EXCEPTION 'a meeting summary chat keeps only its meeting tools'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.policy_role, NEW.created_by_kind, NEW.created_by_subject_id,
         NEW.metadata->'meetingSummaryRecordingId', NEW.tools, NEW.tool_policy,
         NEW.first_party_mcp_tools, NEW.first_party_mcp_permissions, NEW.resources,
         NEW.skills, NEW.sandbox_backend, NEW.sandbox_group_id, NEW.agent_config,
         NEW.variable_set_ids, NEW.variable_set_id, NEW.rig_id, NEW.rig_version_id,
         NEW.active_sandbox_id)
     IS DISTINCT FROM
     ROW(OLD.policy_role, OLD.created_by_kind, OLD.created_by_subject_id,
         OLD.metadata->'meetingSummaryRecordingId', OLD.tools, OLD.tool_policy,
         OLD.first_party_mcp_tools, OLD.first_party_mcp_permissions, OLD.resources,
         OLD.skills, OLD.sandbox_backend, OLD.sandbox_group_id, OLD.agent_config,
         OLD.variable_set_ids, OLD.variable_set_id, OLD.rig_id, OLD.rig_version_id,
         OLD.active_sandbox_id) THEN
    RAISE EXCEPTION 'a meeting summary chat keeps only its meeting tools'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS meeting_summary_session_shape ON sessions;
CREATE TRIGGER meeting_summary_session_shape BEFORE UPDATE ON sessions
FOR EACH ROW WHEN (OLD.policy_role = 'meeting_summary' AND OLD.created_by_kind = 'service'
  AND OLD.created_by_subject_id = 'meeting-summary')
EXECUTE FUNCTION guard_meeting_summary_session_shape();
DROP TRIGGER IF EXISTS meeting_summary_session_mcp_servers ON session_mcp_servers;
CREATE TRIGGER meeting_summary_session_mcp_servers BEFORE INSERT ON session_mcp_servers
FOR EACH ROW EXECUTE FUNCTION guard_meeting_summary_session_shape();

REVOKE ALL ON FUNCTION guard_meeting_summary_session_shape() FROM PUBLIC;
