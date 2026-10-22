-- deployment-mode: rolling
-- Commit-only hints, not history or authority. Stable payloads let PostgreSQL
-- fold repeated changes to one session in the same transaction. Readers always
-- reconcile after reconnect; no durable counter or per-event outbox is added.
CREATE FUNCTION notify_session_list_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
DECLARE
  workspace uuid;
  session uuid;
  subject text;
  all_scopes boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    IF TG_OP = 'DELETE' THEN
      workspace := OLD.workspace_id;
      all_scopes := true;
    ELSE
      workspace := NEW.workspace_id;
      session := NEW.id;
      IF TG_OP = 'UPDATE' THEN
        -- The former audience cannot resolve a revoked row. A workspace-only
        -- reconciliation hint removes it without disclosing the private ID.
        all_scopes := ROW(OLD.visibility, OLD.owner_subject_id, OLD.channel_id,
          OLD.parent_session_id, OLD.root_session_id, OLD.site_access_root_id,
          OLD.scope_subject_id, OLD.created_by_kind, OLD.created_by_subject_id, OLD.site_id)
          IS DISTINCT FROM ROW(NEW.visibility, NEW.owner_subject_id, NEW.channel_id,
          NEW.parent_session_id, NEW.root_session_id, NEW.site_access_root_id,
          NEW.scope_subject_id, NEW.created_by_kind, NEW.created_by_subject_id, NEW.site_id);
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'session_pins' THEN
    IF TG_OP = 'DELETE' THEN
      workspace := OLD.workspace_id; subject := OLD.subject_id; session := OLD.session_id;
    ELSE
      workspace := NEW.workspace_id; subject := NEW.subject_id; session := NEW.session_id;
    END IF;
  ELSIF TG_TABLE_NAME IN ('session_background_commands', 'sandbox_retained_processes', 'session_turns') THEN
    IF TG_OP = 'DELETE' THEN
      workspace := OLD.workspace_id; session := OLD.session_id;
    ELSE
      workspace := NEW.workspace_id; session := NEW.session_id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN workspace := OLD.workspace_id;
    ELSE workspace := NEW.workspace_id;
    END IF;
    all_scopes := true;
  END IF;
  IF workspace IS NOT NULL THEN
    PERFORM pg_notify('opengeni_session_lists', json_build_object(
      'schema', TG_TABLE_SCHEMA, 'workspaceId', workspace,
      'sessionId', CASE WHEN all_scopes THEN NULL ELSE session END,
      'subjectId', subject, 'all', all_scopes OR session IS NULL)::text);
  END IF;
  RETURN NULL;
END
$function$;
REVOKE ALL ON FUNCTION notify_session_list_change() FROM PUBLIC;

CREATE TRIGGER sessions_list_insert_delete AFTER INSERT OR DELETE ON sessions
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER sessions_list_update AFTER UPDATE OF status, active_turn_id, title, title_source,
  model, reasoning_effort, channel_id, parent_session_id, root_session_id,
  visibility, owner_subject_id, site_access_root_id, admission_block,
  direct_control_state, direct_pause_revision, subtree_run_override_revision,
  input_wait_until, input_wait_turn_id, input_wait_reason, content_archive_state,
  updated_at, metadata ON sessions
FOR EACH ROW WHEN (
  ROW(OLD.status, OLD.active_turn_id, OLD.title, OLD.title_source, OLD.model, OLD.reasoning_effort,
    OLD.channel_id, OLD.parent_session_id, OLD.root_session_id, OLD.visibility,
    OLD.owner_subject_id, OLD.site_access_root_id, OLD.admission_block,
    OLD.direct_control_state, OLD.direct_pause_revision, OLD.subtree_run_override_revision,
    OLD.input_wait_until, OLD.input_wait_turn_id, OLD.input_wait_reason,
    OLD.content_archive_state, OLD.updated_at)
  IS DISTINCT FROM
  ROW(NEW.status, NEW.active_turn_id, NEW.title, NEW.title_source, NEW.model, NEW.reasoning_effort,
    NEW.channel_id, NEW.parent_session_id, NEW.root_session_id, NEW.visibility,
    NEW.owner_subject_id, NEW.site_access_root_id, NEW.admission_block,
    NEW.direct_control_state, NEW.direct_pause_revision, NEW.subtree_run_override_revision,
    NEW.input_wait_until, NEW.input_wait_turn_id, NEW.input_wait_reason,
    NEW.content_archive_state, NEW.updated_at)
  OR ROW(OLD.metadata->'scheduledTaskId', OLD.metadata->'_opengeniSiteOrigin')
    IS DISTINCT FROM ROW(NEW.metadata->'scheduledTaskId', NEW.metadata->'_opengeniSiteOrigin'))
EXECUTE FUNCTION notify_session_list_change();

-- Rare projection/audience edits, separate from the hot event append columns.
CREATE TRIGGER sessions_list_projection_update AFTER UPDATE OF initial_message,
  created_by_kind, created_by_subject_id, scope_subject_id,
  keep_live, content_archived_at, imported_archive_import_id, imported_archive_imported_at,
  site_id ON sessions FOR EACH ROW WHEN (
  ROW(OLD.initial_message, OLD.created_by_kind, OLD.created_by_subject_id,
    OLD.scope_subject_id, OLD.keep_live, OLD.content_archived_at, OLD.imported_archive_import_id,
    OLD.imported_archive_imported_at, OLD.site_id) IS DISTINCT FROM
  ROW(NEW.initial_message, NEW.created_by_kind, NEW.created_by_subject_id,
    NEW.scope_subject_id, NEW.keep_live, NEW.content_archived_at, NEW.imported_archive_import_id,
    NEW.imported_archive_imported_at, NEW.site_id))
EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_turns_list_insert_delete AFTER INSERT OR DELETE ON session_turns
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER session_turns_list_attention_update AFTER UPDATE OF status, updated_at ON session_turns
FOR EACH ROW WHEN ((OLD.status = 'requires_action' OR NEW.status = 'requires_action') AND
  ROW(OLD.status, OLD.updated_at) IS DISTINCT FROM ROW(NEW.status, NEW.updated_at))
EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_pins_list_insert_delete AFTER INSERT OR DELETE ON session_pins
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER session_pins_list_update AFTER UPDATE OF pinned, archived,
  acknowledged_sequence, manually_unread_through, actively_working ON session_pins
FOR EACH ROW WHEN (
  ROW(OLD.pinned, OLD.archived, OLD.acknowledged_sequence, OLD.manually_unread_through,
    OLD.actively_working) IS DISTINCT FROM
  ROW(NEW.pinned, NEW.archived, NEW.acknowledged_sequence, NEW.manually_unread_through,
    NEW.actively_working)) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER session_commands_list_insert_delete AFTER INSERT OR DELETE ON session_background_commands
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER session_commands_list_update AFTER UPDATE OF state, last_reconcile_outcome
ON session_background_commands FOR EACH ROW WHEN (
  ROW(OLD.state, OLD.last_reconcile_outcome) IS DISTINCT FROM
  ROW(NEW.state, NEW.last_reconcile_outcome)) EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER retained_processes_list_update AFTER UPDATE OF state, last_reconcile_outcome
ON sandbox_retained_processes FOR EACH ROW WHEN (
  ROW(OLD.state, OLD.last_reconcile_outcome) IS DISTINCT FROM
  ROW(NEW.state, NEW.last_reconcile_outcome)) EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER retained_processes_list_insert_delete AFTER INSERT OR DELETE ON sandbox_retained_processes
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER schedules_list_insert_delete AFTER INSERT OR DELETE ON scheduled_tasks
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER schedules_list_update AFTER UPDATE OF status, run_mode, reusable_session_id,
  deleted_at, visibility, metadata ON scheduled_tasks
FOR EACH ROW WHEN (ROW(OLD.status, OLD.run_mode, OLD.reusable_session_id, OLD.deleted_at, OLD.visibility,
  OLD.metadata->'creatorSessionId') IS DISTINCT FROM
  ROW(NEW.status, NEW.run_mode, NEW.reusable_session_id, NEW.deleted_at, NEW.visibility,
  NEW.metadata->'creatorSessionId')) EXECUTE FUNCTION notify_session_list_change();

CREATE TRIGGER channels_list_change AFTER INSERT OR DELETE ON channels
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER channels_list_update AFTER UPDATE OF name, pinned, sort_order ON channels
FOR EACH ROW WHEN (ROW(OLD.name, OLD.pinned, OLD.sort_order) IS DISTINCT FROM
  ROW(NEW.name, NEW.pinned, NEW.sort_order)) EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER workspace_memberships_list_change AFTER INSERT OR DELETE ON workspace_memberships
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER workspace_memberships_list_update AFTER UPDATE OF subject_label, role, permissions ON workspace_memberships
FOR EACH ROW WHEN (ROW(OLD.subject_label, OLD.role, OLD.permissions) IS DISTINCT FROM
  ROW(NEW.subject_label, NEW.role, NEW.permissions)) EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER slack_interactions_list_change AFTER INSERT OR DELETE ON slack_interactions
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER slack_interactions_list_update AFTER UPDATE OF visibility, owning_subject_id, session_reservation_id ON slack_interactions
FOR EACH ROW WHEN (ROW(OLD.visibility, OLD.owning_subject_id, OLD.session_reservation_id) IS DISTINCT FROM
  ROW(NEW.visibility, NEW.owning_subject_id, NEW.session_reservation_id)) EXECUTE FUNCTION notify_session_list_change();
CREATE TRIGGER site_session_access_list_change AFTER INSERT OR UPDATE OR DELETE ON site_session_access
FOR EACH ROW EXECUTE FUNCTION notify_session_list_change();
