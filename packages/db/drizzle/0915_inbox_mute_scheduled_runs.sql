-- deployment-mode: rolling
-- online-safety-exception: nonconcurrent-index: inbox_session_mutes holds one row per chat a person muted, a few rows per person, so the index builds instantly
-- online-safety-exception: unbatched-data: the backfill touches only inbox_session_mutes, one row per chat a person muted, a few rows per person
-- A schedule that starts a new session for every run produces a fresh session
-- each time, so muting one run's replies left every later run unmuted. Muting a
-- run of such a schedule now mutes the schedule: its earlier and later runs'
-- replies stop reaching the person, and unmuting any run brings them back.
-- Sessions a schedule reuses or targets keep the one-session mute they had.
-- Existing mutes on such runs are backfilled so they cover their schedule.
-- Signatures are unchanged, so the previous release keeps calling the same
-- functions and simply gets the schedule-wide behaviour.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.inbox_session_mutes ADD COLUMN scheduled_task_id uuid;
CREATE INDEX inbox_session_mutes_schedule_idx
  ON opengeni_private.inbox_session_mutes (scheduled_task_id, subject_id)
  WHERE scheduled_task_id IS NOT NULL;

-- The schedule whose every run starts its own session, when this session is
-- one of those runs. Null for any other session. Internal: only the owner-run
-- mute functions below call it, so it runs with their rights and is granted to
-- no one.
CREATE FUNCTION opengeni_private.session_reply_mute_schedule_v1(p_session_id uuid)
RETURNS uuid
LANGUAGE sql STABLE SET search_path FROM CURRENT AS $schedule$
  SELECT task.id
  FROM sessions session
  JOIN scheduled_task_runs run
    ON run.workspace_id = session.workspace_id AND run.session_id = session.id
  JOIN scheduled_tasks task ON task.id = run.task_id
  WHERE session.id = p_session_id AND task.run_mode = 'new_session_per_run'
  ORDER BY run.created_at DESC
  LIMIT 1
$schedule$;

-- True when the person this session works for has muted its replies, on this
-- session or on the schedule that started it.
CREATE OR REPLACE FUNCTION opengeni_private.session_replies_muted_v1(p_session_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $muted$
  SELECT opengeni_private.session_replies_muted_for_v1(session.id,
    opengeni_private.session_person_v1(session.workspace_id, session.id,
      session.owner_subject_id, session.created_by_subject_id))
  FROM sessions session
  WHERE session.id = p_session_id
$muted$;

-- Whether this person muted this session's replies, directly or through the
-- schedule that started it.
CREATE OR REPLACE FUNCTION opengeni_private.session_replies_muted_for_v1(
  p_session_id uuid, p_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT AS $muted_for$
  SELECT p_subject_id IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM opengeni_private.inbox_session_mutes mute
      WHERE mute.session_id = p_session_id AND mute.subject_id = p_subject_id
    )
    OR EXISTS (
      SELECT 1 FROM opengeni_private.inbox_session_mutes mute
      WHERE mute.scheduled_task_id =
          (SELECT opengeni_private.session_reply_mute_schedule_v1(p_session_id))
        AND mute.subject_id = p_subject_id
    )
  )
$muted_for$;

-- Mute or unmute one session's replies for this person. On a run of a schedule
-- that starts a new session per run, this mutes or unmutes the schedule.
-- Muting takes the affected reply items out of their inbox.
CREATE OR REPLACE FUNCTION opengeni_private.set_session_replies_muted_v1(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_subject_id text,
  p_muted boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $set_muted$
DECLARE
  v_task uuid := opengeni_private.session_reply_mute_schedule_v1(p_session_id);
BEGIN
  IF p_muted THEN
    INSERT INTO opengeni_private.inbox_session_mutes
      (account_id, workspace_id, session_id, subject_id, scheduled_task_id)
    VALUES (p_account_id, p_workspace_id, p_session_id, p_subject_id, v_task)
    ON CONFLICT (session_id, subject_id)
      DO UPDATE SET scheduled_task_id = EXCLUDED.scheduled_task_id;
    UPDATE opengeni_private.inbox_items item
    SET status = 'withdrawn', resolved_at = now(), updated_at = now()
    WHERE item.recipient_subject_id = p_subject_id
      AND item.kind = 'reply' AND item.status IN ('open', 'dismissed')
      AND (item.session_id = p_session_id OR (v_task IS NOT NULL AND EXISTS (
        SELECT 1 FROM scheduled_task_runs run
        WHERE run.workspace_id = p_workspace_id AND run.task_id = v_task
          AND run.session_id = item.session_id)));
  ELSE
    DELETE FROM opengeni_private.inbox_session_mutes mute
    WHERE mute.subject_id = p_subject_id
      AND (mute.session_id = p_session_id
        OR (v_task IS NOT NULL AND mute.scheduled_task_id = v_task));
  END IF;
  RETURN p_muted;
END
$set_muted$;

-- Sessions and schedule runs are workspace-scoped under FORCE RLS, so each
-- existing mute is resolved inside its own workspace's scope.
DO $inbox_schedule_mute_backfill$
DECLARE
  mute_scope record;
BEGIN
  FOR mute_scope IN
    SELECT DISTINCT mute.account_id, mute.workspace_id
    FROM opengeni_private.inbox_session_mutes mute
    WHERE mute.scheduled_task_id IS NULL
  LOOP
    PERFORM pg_catalog.set_config('opengeni.account_id', mute_scope.account_id::text, true);
    PERFORM pg_catalog.set_config('opengeni.workspace_id', mute_scope.workspace_id::text, true);
    UPDATE opengeni_private.inbox_session_mutes mute
    SET scheduled_task_id = opengeni_private.session_reply_mute_schedule_v1(mute.session_id)
    WHERE mute.workspace_id = mute_scope.workspace_id AND mute.scheduled_task_id IS NULL;
  END LOOP;
  PERFORM pg_catalog.set_config('opengeni.account_id', '', true);
  PERFORM pg_catalog.set_config('opengeni.workspace_id', '', true);
END $inbox_schedule_mute_backfill$;

DO $inbox_schedule_mutes$
DECLARE
  target_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'session_reply_mute_schedule_v1(uuid)',
    'session_replies_muted_v1(uuid)',
    'session_replies_muted_for_v1(uuid,text)',
    'set_session_replies_muted_v1(uuid,uuid,uuid,text,boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION opengeni_private.%s FROM PUBLIC', signature);
    EXECUTE format(
      'ALTER FUNCTION opengeni_private.%s SET search_path = pg_catalog, %I, pg_temp',
      signature, target_schema
    );
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_replies_muted_for_v1(uuid,text),
      opengeni_private.set_session_replies_muted_v1(uuid,uuid,uuid,text,boolean)
    TO opengeni_app;
  END IF;
END $inbox_schedule_mutes$;
