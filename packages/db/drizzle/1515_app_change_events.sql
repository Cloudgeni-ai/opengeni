-- deployment-mode: rolling
-- App data changes become automation triggers and workspace webhook events
-- (docs/site-data.md "Change events", docs/design/opengeni-events-as-triggers.md).
--
-- - workspace_activity_events gains the App a fact is about (site_id) and,
--   for records only some people may read, who may read it
--   (reader_subject_id, reader_owner_only). The API writes one fact per
--   added, changed or removed App Data record (app.record.*) and one per
--   App SQL write (app.sql.changed), only while someone listens: an active
--   "This workspace" source or a workspace webhook subscribed to an app type.
-- - Row security: an App fact is visible to a person who may open the App
--   (shared with the workspace, or their own Only me App). A fact about a
--   record in a collection where people read only their own records is
--   visible to the record's owner and, unless records are private, to the
--   App's owner or creator and workspace administrators. Chat and usage
--   facts keep their 1105 rules; they never carry an App.
-- - Workspace webhooks may subscribe to the four app types. An AFTER INSERT
--   trigger on App facts enqueues their deliveries, leaving out record
--   contents a webhook may not see (per-person records, and every record of
--   an App not shared with the workspace).
--
-- Rolling: two nullable columns and a defaulted boolean on a 24-hour facts
-- table, a replaced read policy whose chat and usage branches are unchanged,
-- a widened NOT VALID check, and a new invoker trigger. The previous release
-- never writes App facts and never reads the new columns; until it is gone
-- no endpoint can subscribe to the new types through it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE workspace_activity_events
  ADD COLUMN site_id uuid,
  ADD COLUMN reader_subject_id text,
  ADD COLUMN reader_owner_only boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_activity_events ADD CONSTRAINT workspace_activity_events_reader_chk CHECK (
  (reader_subject_id IS NULL OR octet_length(reader_subject_id) BETWEEN 1 AND 1024)
  AND (site_id IS NOT NULL OR (reader_subject_id IS NULL AND NOT reader_owner_only))
) NOT VALID;
COMMENT ON COLUMN workspace_activity_events.site_id IS 'The App (workspace_artifacts row) an app.* fact is about; null for chat and usage facts.';
COMMENT ON COLUMN workspace_activity_events.reader_subject_id IS 'For a record only some people may read: its owner (a subject id, or principal:<principal> for a non-person owner).';
COMMENT ON COLUMN workspace_activity_events.reader_owner_only IS 'True when only reader_subject_id may see the fact (private records).';

DROP POLICY workspace_activity_read ON workspace_activity_events;
-- Chat facts: whoever may see the chat. Usage facts: the member they are
-- about, or for workspace-wide usage, the workspace's administrators. App
-- facts: whoever may open the App, narrowed per record as described above.
CREATE POLICY workspace_activity_read ON workspace_activity_events
  FOR SELECT
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND (
      (site_id IS NULL AND session_id IS NOT NULL
        AND session_reference_visible(account_id, workspace_id, session_id))
      OR (site_id IS NULL AND session_id IS NULL AND (
        subject_id = opengeni_private.current_subject_id()
        OR (subject_id IS NULL AND EXISTS (
          SELECT 1 FROM workspace_memberships member
          WHERE member.account_id = workspace_activity_events.account_id
            AND member.workspace_id = workspace_activity_events.workspace_id
            AND member.subject_id = opengeni_private.current_subject_id()
            AND opengeni_private.workspace_membership_administers(member.role, member.permissions)))
      ))
      OR (site_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM workspace_artifacts app
        WHERE app.workspace_id = workspace_activity_events.workspace_id
          AND app.id = workspace_activity_events.site_id
          AND (app.visibility = 'workspace_shared'
            OR app.owner_subject_id = opengeni_private.current_subject_id())
          AND (
            workspace_activity_events.reader_subject_id IS NULL
            OR workspace_activity_events.reader_subject_id = opengeni_private.current_subject_id()
            OR (NOT workspace_activity_events.reader_owner_only AND (
              app.owner_subject_id = opengeni_private.current_subject_id()
              OR app.created_by_subject_id = opengeni_private.current_subject_id()
              OR EXISTS (
                SELECT 1 FROM workspace_memberships member
                WHERE member.account_id = workspace_activity_events.account_id
                  AND member.workspace_id = workspace_activity_events.workspace_id
                  AND member.subject_id = opengeni_private.current_subject_id()
                  AND opengeni_private.workspace_membership_administers(member.role, member.permissions))))
          )))
    )
  );

ALTER TABLE workspace_webhooks DROP CONSTRAINT workspace_webhooks_event_types_chk;
ALTER TABLE workspace_webhooks ADD CONSTRAINT workspace_webhooks_event_types_chk CHECK (
  cardinality(event_types) BETWEEN 1 AND 32 AND event_types <@ ARRAY[
    'turn.completed','turn.failed','turn.cancelled','turn.superseded','session.status.changed',
    'session.requiresAction','session.humanInput.requested',
    'session.notification.posted','session.notification.withdrawn',
    'session.agentCall.ringing','session.agentCall.settled',
    'usage.threshold_reached','usage.exhausted','usage.period_reset',
    'recording.started','recording.finished','recording.transcript.ready',
    'recording.transcript.failed','recording.transcript.current_changed',
    'recording.speakers.updated','recording.notes.updated','recording.deleted',
    'app.record.added','app.record.changed','app.record.removed','app.sql.changed'
  ]::text[]
) NOT VALID;

-- One delivery per subscribed workspace webhook for an App fact. Record
-- contents only some people may read stay out of the delivery: records in a
-- collection where people read only their own, and every record of an App
-- that isn't shared with the workspace (an Only me App, or one this
-- transaction can't see). The ids, collection and kind of change are still
-- sent.
CREATE FUNCTION opengeni_private.enqueue_app_activity_workspace_webhooks_v1() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $$
DECLARE
  v_data jsonb := NEW.data;
BEGIN
  BEGIN
    IF NEW.reader_subject_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM workspace_artifacts app
      WHERE app.workspace_id = NEW.workspace_id AND app.id = NEW.site_id
        AND app.visibility = 'workspace_shared') THEN
      v_data := (v_data - 'record') || jsonb_build_object('recordWithheld', true);
    END IF;
    v_data := v_data || jsonb_build_object('appId', NEW.site_id, 'chainDepth', NEW.chain_depth)
      || CASE WHEN NEW.automation_id IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('automationId', NEW.automation_id,
          'automationRunId', NEW.automation_run_id) END;
    INSERT INTO workspace_webhook_deliveries (account_id, workspace_id, webhook_id, event_id, event_type, payload)
    SELECT webhook.account_id, webhook.workspace_id, webhook.id, NEW.id, NEW.type,
      jsonb_build_object(
        'id', NEW.id, 'type', NEW.type, 'lane', 'workspace', 'workspaceId', NEW.workspace_id,
        'workspace', jsonb_build_object('id', workspace.id, 'externalSource', workspace.external_source,
          'externalId', workspace.external_id),
        'occurredAt', to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'data', v_data
      )
    FROM workspace_webhooks webhook
    JOIN workspaces workspace ON workspace.id = NEW.workspace_id AND workspace.account_id = NEW.account_id
    WHERE webhook.account_id = NEW.account_id AND webhook.workspace_id = NEW.workspace_id
      AND webhook.enabled AND NEW.type = ANY(webhook.event_types)
    ON CONFLICT (webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'app webhook enqueue skipped for fact %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END $$;

DO $search_paths$
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.enqueue_app_activity_workspace_webhooks_v1() SET search_path = pg_catalog, %I, pg_temp', current_schema());
END
$search_paths$;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_app_activity_workspace_webhooks_v1() FROM PUBLIC;

CREATE TRIGGER workspace_activity_events_app_webhook_enqueue_v1
  AFTER INSERT ON workspace_activity_events
  FOR EACH ROW WHEN (NEW.site_id IS NOT NULL)
  EXECUTE FUNCTION opengeni_private.enqueue_app_activity_workspace_webhooks_v1();
