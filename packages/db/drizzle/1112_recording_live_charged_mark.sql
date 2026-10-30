-- deployment-mode: rolling
-- Live transcript audio charged in credits, per track.
--
-- live_charged_milliseconds: how far the track's streamed audio is paid for.
-- Each save of live text records the charge from this mark to the stored
-- streamed total and moves the mark in the same transaction, so a range is
-- charged once however saves overlap or retry. Audio streamed to a model not
-- charged in credits counts at list price instead and moves the mark too.
--
-- live_charged_cost_usd_micros: the list price of that charged audio. The
-- track's live_cost_usd_micros stays the list price of everything streamed
-- (as the previous release writes it), and a usage allowance that prices
-- unbilled use counts only the difference, so audio charged in credits never
-- counts twice, also after a switch to an uncharged model. (During a rolling
-- deploy, audio a pod of the previous release saves counts at list price and
-- is then charged by the next save on this release; see docs/recordings.md.)
--
-- Live sessions of a track charged in credits are bounded by the audio its
-- recorder reports, against time measured between its reports so a pause
-- never counts: live_grants counts the sessions granted; live_granted_at is
-- when the latest began; live_reported_at is the recorder's latest save of
-- the track's total; live_counted_at is how far live_covered_milliseconds
-- counts, the time that ended in a report of more audio, at most that audio
-- plus a minute (or, for a session never reported on, the time up to the next
-- request); live_unbacked_milliseconds is the rest of that time, which no
-- reported audio accounts for; and live_unreported_grants counts sessions
-- never reported on. Time counts only within the latest session's longest
-- possible run (an hour from its grant), so a long pause counts at most that.
--
-- A session granted to a track charged in credits counts all it could run
-- (an hour) up front, as provisional time (live_provisional_milliseconds, in
-- the hour live_provisional_hour); each report or new request swaps it for
-- the time it actually left unaccounted plus what it could still run, so a
-- session nobody reports on costs its whole hour.
--
-- recording_live_unbacked_hours adds up that unbacked time, and the live
-- audio charged in credits, per person (every API key of a workspace
-- together, since no key records who made it) and workspace, per hour, so a
-- person's live sessions are bounded per day across recordings: at most 4
-- hours of unbacked time plus as much as was charged. Each row is private to
-- its own person (or to the workspace's API keys): it holds no recording,
-- only time.
--
-- Rolling: nullable columns without default or check are catalog-only, and
-- the previous release never reads or writes them; null means none charged
-- or granted yet. The allowance trigger function keeps its signature and,
-- with the charged column null, counts exactly what it counted before. The
-- new table is only used by this release.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recording_tracks
  ADD COLUMN IF NOT EXISTS live_charged_milliseconds integer,
  ADD COLUMN IF NOT EXISTS live_charged_cost_usd_micros bigint,
  ADD COLUMN IF NOT EXISTS live_grants integer,
  ADD COLUMN IF NOT EXISTS live_granted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS live_reported_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS live_counted_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS live_covered_milliseconds bigint,
  ADD COLUMN IF NOT EXISTS live_unbacked_milliseconds bigint,
  ADD COLUMN IF NOT EXISTS live_unreported_grants integer,
  ADD COLUMN IF NOT EXISTS live_provisional_milliseconds bigint,
  ADD COLUMN IF NOT EXISTS live_provisional_hour timestamp with time zone;
COMMENT ON COLUMN recording_tracks.live_charged_milliseconds IS
  'Streamed live transcript audio already paid for (charged in credits, or counted at list price once charging began), in milliseconds. Null when none was charged.';
COMMENT ON COLUMN recording_tracks.live_charged_cost_usd_micros IS
  'List price of the live transcript audio charged in credits; usage allowances never count it. Null when none was charged.';
COMMENT ON COLUMN recording_tracks.live_grants IS
  'Live transcript sessions granted for this track. Null when none was.';
COMMENT ON COLUMN recording_tracks.live_granted_at IS
  'When the latest live transcript session for this track was granted; null when none is open.';
COMMENT ON COLUMN recording_tracks.live_reported_at IS
  'When the recorder last saved this track''s streamed total.';
COMMENT ON COLUMN recording_tracks.live_counted_at IS
  'How far live_covered_milliseconds counts: the latest grant or report of this track''s live transcript.';
COMMENT ON COLUMN recording_tracks.live_covered_milliseconds IS
  'Time by the server''s clock that ended in a report of more streamed audio for this track, or in a request after a session never reported on.';
COMMENT ON COLUMN recording_tracks.live_unbacked_milliseconds IS
  'Time between this track''s live reports that no reported audio accounts for (a pause, or audio nobody reported), within each session''s longest possible run.';
COMMENT ON COLUMN recording_tracks.live_unreported_grants IS
  'Live transcript sessions of this track the recorder never reported on before asking for another.';
COMMENT ON COLUMN recording_tracks.live_provisional_milliseconds IS
  'What this track''s open live session could still stream, counted up front against the person''s day in recording_live_unbacked_hours; null when nothing is.';
COMMENT ON COLUMN recording_tracks.live_provisional_hour IS
  'The hour of recording_live_unbacked_hours that live_provisional_milliseconds was counted in.';

CREATE TABLE IF NOT EXISTS recording_live_unbacked_hours (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  -- The person, or 'api_key' for every API key of the workspace.
  bound_subject_id text NOT NULL CHECK (length(bound_subject_id) BETWEEN 1 AND 1024),
  hour_start timestamp with time zone NOT NULL,
  unbacked_milliseconds bigint NOT NULL CHECK (unbacked_milliseconds >= 0),
  -- Live audio charged in credits; the day's bound grows by it.
  charged_milliseconds bigint NOT NULL DEFAULT 0 CHECK (charged_milliseconds >= 0),
  PRIMARY KEY (workspace_id, bound_subject_id, hour_start),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
COMMENT ON TABLE recording_live_unbacked_hours IS
  'Live transcript time no reported audio accounts for, per person (or the workspace''s API keys together) and hour; a day of it is bounded.';
ALTER TABLE recording_live_unbacked_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE recording_live_unbacked_hours FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON recording_live_unbacked_hours;
CREATE POLICY workspace_isolation ON recording_live_unbacked_hours
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND bound_subject_id = CASE
      WHEN opengeni_private.current_subject_id() LIKE 'api\_key:%' THEN 'api_key'
      ELSE opengeni_private.current_subject_id()
    END
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND bound_subject_id = CASE
      WHEN opengeni_private.current_subject_id() LIKE 'api\_key:%' THEN 'api_key'
      ELSE opengeni_private.current_subject_id()
    END
  );
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recording_live_unbacked_hours TO opengeni_app;
  END IF;
END $$;

-- Same signature; only the recording_tracks branch changes: it counts the
-- growth of the list price of audio not charged in credits.
DO $install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION count_unbilled_model_allowance_debit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', %1$I, 'pg_temp'
    AS $body$
DECLARE human text; unbilled bigint;
BEGIN
  IF TG_TABLE_NAME='recording_transcript_versions' THEN
    IF NEW.credit_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
    -- A dictation from the previous release recorded its credit charge as its cost.
    PERFORM 1 FROM recordings r WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id
      AND (r.purpose<>'dictation' OR NEW.model<>'voice-input');
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,
      NEW.requested_by_subject_id,NEW.cost_usd_micros,TG_TABLE_SCHEMA);
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME='recording_tracks' THEN
    -- Audio charged in credits is paid already; only the rest is unbilled.
    unbilled := (coalesce(NEW.live_cost_usd_micros,0)-coalesce(NEW.live_charged_cost_usd_micros,0))
      -(coalesce(OLD.live_cost_usd_micros,0)-coalesce(OLD.live_charged_cost_usd_micros,0));
    IF unbilled <= 0 THEN RETURN NULL; END IF;
    SELECT r.owner_subject_id INTO human FROM recordings r
      WHERE r.id=NEW.recording_id AND r.workspace_id=NEW.workspace_id AND r.purpose<>'dictation';
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,human,
      unbilled,TG_TABLE_SCHEMA);
    RETURN NULL;
  END IF;
  IF NEW.workspace_id IS NULL OR NEW.priced_cost_micros <> 0
    OR coalesce(NEW.estimated_provider_cost_micros,0) <= 0 THEN RETURN NULL; END IF;
  -- A late cost fill-in counts once; an unchanged or already-priced row never recounts.
  IF TG_OP='UPDATE' AND OLD.estimated_provider_cost_micros IS NOT NULL THEN RETURN NULL; END IF;
  SELECT receipt.attribution->>'initiatingHumanSubjectId' INTO human
  FROM opengeni_private.usage_allowance_attribution_receipts receipt
    WHERE receipt.source_kind='turn' AND receipt.source_id=NEW.turn_id::text
      AND receipt.workspace_id=NEW.workspace_id AND receipt.account_id=NEW.account_id;
  PERFORM count_unbilled_allowance_usage(NEW.account_id,NEW.workspace_id,human,
    NEW.estimated_provider_cost_micros,TG_TABLE_SCHEMA);
  RETURN NULL;
END $body$
$create$, data_schema);
END $install$;
REVOKE ALL ON FUNCTION count_unbilled_model_allowance_debit() FROM PUBLIC;
