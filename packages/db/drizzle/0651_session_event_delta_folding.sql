-- deployment-mode: rolling
-- Fold streamed text deltas after their turn settles.
--
-- A model answer or reasoning stream is stored as one session_events row per
-- provider fragment, often thousands per turn. Once the turn is terminal, the
-- maintenance worker replaces each run of adjacent fragments with its first
-- row, now carrying the whole text plus a compact, lossless record of every
-- original fragment (id, sequence, timestamps, producer sequence and length),
-- and removes the other rows. Readers already treat a delta whose payload has
-- `coalescedUntil` as covering the sequences up to it, which is exactly the
-- shape the live stream sends. See docs/session-storage-lifecycle.md.
SET LOCAL lock_timeout = '5s';

-- Progress bookkeeping only, reached exclusively through the definer routines
-- below, so it needs no application grants or row-level policies.
CREATE TABLE opengeni_private.session_turn_delta_folds (
  workspace_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  folded_runs integer NOT NULL,
  removed_rows integer NOT NULL,
  folded_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_turn_delta_folds_pkey PRIMARY KEY (workspace_id, turn_id),
  CONSTRAINT session_turn_delta_folds_turn_fk
    FOREIGN KEY (turn_id) REFERENCES session_turns (id) ON DELETE CASCADE
);
REVOKE ALL ON TABLE opengeni_private.session_turn_delta_folds FROM PUBLIC;

-- Terminal turns that settled at least p_settle_seconds ago and were not
-- folded yet. Archived sessions are skipped: their purge removes deltas.
CREATE FUNCTION opengeni_private.session_delta_fold_candidates(
  p_settle_seconds bigint,
  p_limit integer
)
RETURNS TABLE (account_id uuid, workspace_id uuid, session_id uuid, turn_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
  SELECT T.account_id, T.workspace_id, T.session_id, T.id
  FROM session_turns T
  JOIN sessions S ON S.workspace_id = T.workspace_id AND S.id = T.session_id
  WHERE T.status IN ('completed', 'failed', 'cancelled', 'superseded', 'withdrawn_for_edit')
    AND T.updated_at < clock_timestamp() - make_interval(secs => greatest(p_settle_seconds, 60))
    AND S.content_archive_state IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM opengeni_private.session_turn_delta_folds F
      WHERE F.workspace_id = T.workspace_id AND F.turn_id = T.id)
  ORDER BY T.updated_at, T.id
  LIMIT least(greatest(p_limit, 0), 500);
$$;

-- Replace one run of adjacent deltas [p_first, p_last] with its first row.
-- Refuses (returns -1, changing nothing) unless the turn is terminal and the
-- rows in the range are exactly p_ids, in order, all one delta type of that
-- turn sharing one producer and turn binding. The caller computed the folded
-- payload from those very rows; ids pin it to them.
CREATE FUNCTION opengeni_private.fold_session_event_delta_run(
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_first integer,
  p_last integer,
  p_ids uuid[],
  p_payload jsonb,
  p_payload_codec_version integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  turn_status text;
  previous_writer text;
  matched integer;
  removed integer;
BEGIN
  IF p_last <= p_first OR array_length(p_ids, 1) IS DISTINCT FROM p_last - p_first + 1
    OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
    OR (p_payload->>'coalescedUntil')::integer IS DISTINCT FROM p_last
    OR p_payload->'folded'->>'v' IS DISTINCT FROM '1' THEN
    RETURN -1;
  END IF;
  SELECT T.status INTO turn_status FROM session_turns T
  WHERE T.workspace_id = p_workspace_id AND T.session_id = p_session_id AND T.id = p_turn_id;
  IF turn_status IS NULL
    OR turn_status NOT IN ('completed', 'failed', 'cancelled', 'superseded', 'withdrawn_for_edit') THEN
    RETURN -1;
  END IF;
  WITH rows AS (
    SELECT E.id, E.sequence, E.type, E.turn_id, E.producer_id, E.turn_generation,
      E.turn_attempt_id, E.turn_association, E.client_event_id, E.duplicate_of_event_id
    FROM session_events E
    WHERE E.workspace_id = p_workspace_id AND E.session_id = p_session_id
      AND E.sequence BETWEEN p_first AND p_last
    FOR UPDATE
  ), first_row AS (
    SELECT * FROM rows WHERE sequence = p_first
  )
  SELECT count(*) INTO matched
  FROM rows R, first_row F
  WHERE R.id = p_ids[R.sequence - p_first + 1]
    AND R.type IN ('agent.message.delta', 'agent.reasoning.delta')
    AND R.type = F.type
    AND R.producer_id IS NOT DISTINCT FROM F.producer_id
    AND R.turn_generation IS NOT DISTINCT FROM F.turn_generation
    AND R.turn_attempt_id IS NOT DISTINCT FROM F.turn_attempt_id
    AND R.turn_association IS NOT DISTINCT FROM F.turn_association
    AND R.client_event_id IS NULL
    AND R.duplicate_of_event_id IS NULL
    AND R.turn_id = p_turn_id;
  IF matched <> p_last - p_first + 1 THEN
    RETURN -1;
  END IF;
  -- The payload is written with its codec version explicitly (lossless writer).
  previous_writer := current_setting('opengeni.lossless_content_writer', true);
  PERFORM set_config('opengeni.lossless_content_writer', '1', true);
  UPDATE session_events
  SET payload = p_payload, payload_codec_version = p_payload_codec_version
  WHERE workspace_id = p_workspace_id AND session_id = p_session_id AND sequence = p_first;
  PERFORM set_config('opengeni.lossless_content_writer', coalesce(previous_writer, ''), true);
  DELETE FROM session_events
  WHERE workspace_id = p_workspace_id AND session_id = p_session_id
    AND sequence > p_first AND sequence <= p_last;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

CREATE FUNCTION opengeni_private.mark_session_turn_deltas_folded(
  p_workspace_id uuid,
  p_turn_id uuid,
  p_folded_runs integer,
  p_removed_rows integer
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  INSERT INTO opengeni_private.session_turn_delta_folds
    (workspace_id, turn_id, folded_runs, removed_rows)
  SELECT T.workspace_id, T.id, greatest(p_folded_runs, 0), greatest(p_removed_rows, 0)
  FROM session_turns T
  WHERE T.workspace_id = p_workspace_id AND T.id = p_turn_id
  ON CONFLICT (workspace_id, turn_id) DO UPDATE
    SET folded_runs = opengeni_private.session_turn_delta_folds.folded_runs + EXCLUDED.folded_runs,
      removed_rows = opengeni_private.session_turn_delta_folds.removed_rows + EXCLUDED.removed_rows,
      folded_at = now();
$$;

REVOKE ALL ON FUNCTION opengeni_private.session_delta_fold_candidates(bigint, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.fold_session_event_delta_run(
  uuid, uuid, uuid, integer, integer, uuid[], jsonb, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.mark_session_turn_deltas_folded(uuid, uuid, integer, integer)
  FROM PUBLIC;
DO $fold_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_delta_fold_candidates(bigint, integer),
      opengeni_private.fold_session_event_delta_run(
        uuid, uuid, uuid, integer, integer, uuid[], jsonb, integer),
      opengeni_private.mark_session_turn_deltas_folded(uuid, uuid, integer, integer)
      TO opengeni_app;
  END IF;
END
$fold_grants$;

-- Turns are discovered in settle order; keep that scan narrow.
CREATE INDEX IF NOT EXISTS session_turns_settled_fold_idx
  ON session_turns (updated_at, id)
  WHERE status IN ('completed', 'failed', 'cancelled', 'superseded', 'withdrawn_for_edit');
