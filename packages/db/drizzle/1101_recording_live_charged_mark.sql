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
-- counts twice: not after a switch to an uncharged model, nor when a pod of
-- the previous release writes the total during a rolling deploy.
--
-- live_grants and live_first_granted_at: live sessions granted for the track,
-- and when the first was. The recorder reports its own streamed total, so a
-- track whose grants run far ahead of what it reports gets no more.
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
  ADD COLUMN IF NOT EXISTS live_first_granted_at timestamp with time zone;
COMMENT ON COLUMN recording_tracks.live_charged_milliseconds IS
  'Streamed live transcript audio already paid for (charged in credits, or counted at list price once charging began), in milliseconds. Null when none was charged.';
COMMENT ON COLUMN recording_tracks.live_charged_cost_usd_micros IS
  'List price of the live transcript audio charged in credits; usage allowances never count it. Null when none was charged.';
COMMENT ON COLUMN recording_tracks.live_grants IS
  'Live transcript sessions granted for this track. Null when none was.';
COMMENT ON COLUMN recording_tracks.live_first_granted_at IS
  'When the first live transcript session for this track was granted.';

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
