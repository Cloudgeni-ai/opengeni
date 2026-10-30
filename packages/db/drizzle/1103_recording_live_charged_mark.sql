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
-- never reported on.
--
-- Rolling: nullable columns without default or check are catalog-only, and
-- the previous release never reads or writes them; null means none charged
-- or granted yet. The allowance trigger function keeps its signature and,
-- with the charged column null, counts exactly what it counted before.
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
  ADD COLUMN IF NOT EXISTS live_unreported_grants integer;
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
  'Time between this track''s live reports that no reported audio accounts for (a pause, or audio nobody reported); a person''s tracks may have only so much of it a day.';
COMMENT ON COLUMN recording_tracks.live_unreported_grants IS
  'Live transcript sessions of this track the recorder never reported on before asking for another.';

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
