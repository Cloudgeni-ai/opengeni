-- deployment-mode: rolling
-- Infrastructure diagnostics are not session activity. The idle reaper appends
-- `sandbox.box.terminated` to every session sharing a drained box, and that
-- statement stamped each session's `updated_at` (and so its `activity_xid`):
-- stopped chats jumped to the top of the rail with a fresh "last activity"
-- time although no turn had run. A statement whose events are all raw deltas
-- or infrastructure diagnostics still advances the durable cursor and the
-- `last_sequence` compatibility projection, but leaves `updated_at` alone.
-- Updating only `last_sequence` keeps `sessions_stamp_activity_xid` (which
-- fires on `UPDATE OF updated_at, channel_id, activity_xid`) quiet, so the
-- rail order, the displayed time and incremental discovery agree. Any other
-- event in the same statement keeps the existing activity projection.
-- Literal list owned by SESSION_ACTIVITY_NEUTRAL_EVENT_TYPES in
-- packages/db/src/session-meaningful-events.ts. No backfill.
DO $infrastructure_events_keep_activity$
DECLARE
  definition text;
  aggregate_anchor text := E'      )) AS advances_activity\n';
  projection_anchor text := E'      UPDATE sessions session\n      SET last_sequence = inserted_group.last_sequence,\n          updated_at = greatest(session.updated_at, statement_timestamp())\n      WHERE session.account_id = inserted_group.account_id\n        AND session.workspace_id = inserted_group.workspace_id\n        AND session.id = inserted_group.session_id;\n';
BEGIN
  definition := pg_get_functiondef('advance_session_event_cursors_for_inserted_events()'::regprocedure);
  IF (length(definition) - length(replace(definition, aggregate_anchor, ''))) / length(aggregate_anchor) <> 1
    OR (length(definition) - length(replace(definition, projection_anchor, ''))) / length(projection_anchor) <> 1
  THEN
    RAISE EXCEPTION '0904 session activity projection prerequisites differ' USING ERRCODE = '55000';
  END IF;
  definition := replace(definition, aggregate_anchor,
    E'      )) AS advances_activity,\n'
    || E'      BOOL_OR(type NOT IN (\n'
    || E'        ''agent.message.delta'',\n'
    || E'        ''agent.reasoning.delta'',\n'
    || E'        ''sandbox.command.output.delta'',\n'
    || E'        ''terminal.pty.output.delta'',\n'
    || E'        ''sandbox.box.created'',\n'
    || E'        ''sandbox.box.terminated'',\n'
    || E'        ''sandbox.box.snapshot'',\n'
    || E'        ''sandbox.env.drift'',\n'
    || E'        ''session.route.reconciled'',\n'
    || E'        ''workspace.revision.captured'',\n'
    || E'        ''machine.op.recovered'',\n'
    || E'        ''machine.link.restored'',\n'
    || E'        ''machine.runner.restarted''\n'
    || E'      )) AS advances_updated_at\n');
  definition := replace(definition, projection_anchor,
    E'      IF inserted_group.advances_updated_at THEN\n'
    || E'        UPDATE sessions session\n'
    || E'        SET last_sequence = inserted_group.last_sequence,\n'
    || E'            updated_at = greatest(session.updated_at, statement_timestamp())\n'
    || E'        WHERE session.account_id = inserted_group.account_id\n'
    || E'          AND session.workspace_id = inserted_group.workspace_id\n'
    || E'          AND session.id = inserted_group.session_id;\n'
    || E'      ELSE\n'
    || E'        UPDATE sessions session\n'
    || E'        SET last_sequence = inserted_group.last_sequence\n'
    || E'        WHERE session.account_id = inserted_group.account_id\n'
    || E'          AND session.workspace_id = inserted_group.workspace_id\n'
    || E'          AND session.id = inserted_group.session_id;\n'
    || E'      END IF;\n');
  -- Preserve the attention predicate, range validation, tenancy capability,
  -- owner, grants and pinned search_path of the installed function.
  EXECUTE definition;
END
$infrastructure_events_keep_activity$;
