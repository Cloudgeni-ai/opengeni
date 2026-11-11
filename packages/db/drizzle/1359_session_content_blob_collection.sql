-- deployment-mode: rolling
-- Collect session content blobs nothing refers to any more
-- (docs/session-storage-lifecycle.md, "Collecting unreferenced blobs").
--
-- A model-request snapshot is kept per attempt and replaced by every later
-- request of that attempt, and each request writes the chunks of its raw body
-- that the session did not hold yet. The chunks only the replaced snapshot
-- named stay in session_content_blobs until the session is archived, so a
-- long attempt leaves most of its request bodies behind as unreferenced rows.
--
-- opengeni_private.session_content_garbage_candidates_v1(limit) lists, as
-- routing ids only, live sessions whose snapshots changed since their last
-- collection, sessions never collected first.
--
-- opengeni_private.collect_session_content_garbage_v1(workspace, session,
-- limit) runs in that session's workspace RLS context and deletes up to
-- `limit` blobs of the live session that no snapshot or tool catalog of the
-- session names and that are older than ten minutes. It takes the session's
-- content lock exclusively, and only if it is free: every blob writer and
-- snapshot reader holds the same lock shared for its transaction, so a
-- deletion can never race a writer that found a blob present and is about to
-- refer to it, or a reader between reading a snapshot and its blobs. Busy, not
-- live or out of scope returns 0 and records nothing. A call that deleted
-- fewer than `limit` rows records how far the session is collected.
--
-- As 0937, 0978 and 1060 explain, the previous release rejects a runtime
-- EXECUTE grant on a definer it doesn't know, so this migration grants
-- nothing. Until a later migration grants them the maintenance pass collects
-- nothing (as before); an operator can run the collector as the owner.
--
-- Rolling: a new owner-only private table without grants, and two definers
-- the previous release never calls.
SET LOCAL lock_timeout = '5s';

CREATE TABLE opengeni_private.session_content_collections (
  data_schema text NOT NULL,
  session_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  -- Every unreferenced blob of the session created before this was deleted.
  collected_before timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (data_schema, session_id)
);

REVOKE ALL ON TABLE opengeni_private.session_content_collections FROM PUBLIC;

DO $session_content_blob_collection$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.session_content_garbage_candidates_v1(p_limit integer)
    RETURNS TABLE(account_id uuid, workspace_id uuid, session_id uuid)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT live.account_id, live.workspace_id, live.id
      FROM (
        SELECT snapshot_row.workspace_id, snapshot_row.session_id,
          max(snapshot_row.captured_at) AS last_capture
        FROM session_attempt_model_context_snapshots snapshot_row
        WHERE snapshot_row.content_refs IS NOT NULL
        GROUP BY snapshot_row.workspace_id, snapshot_row.session_id
      ) changed
      JOIN sessions live
        ON live.workspace_id = changed.workspace_id AND live.id = changed.session_id
        AND live.content_archive_state IS NULL
      LEFT JOIN opengeni_private.session_content_collections collection
        ON collection.data_schema = %1$L AND collection.session_id = changed.session_id
      -- A session is revisited at most every ten minutes, and only when a
      -- snapshot changed after the point it is collected to.
      WHERE collection.session_id IS NULL
        OR (changed.last_capture > collection.collected_before
          AND collection.collected_before < pg_catalog.now() - interval '20 minutes')
      ORDER BY collection.collected_before NULLS FIRST, changed.session_id
      LIMIT least(greatest(p_limit, 0), 1000)
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.collect_session_content_garbage_v1(
      p_workspace_id uuid, p_session_id uuid, p_limit integer)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_batch integer := least(greatest(p_limit, 1), 10000);
      v_before timestamptz := pg_catalog.now() - interval '10 minutes';
      v_deleted integer;
    BEGIN
      IF p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id() THEN
        RETURN 0;
      END IF;
      PERFORM 1 FROM sessions live
      WHERE live.workspace_id = p_workspace_id AND live.id = p_session_id
        AND live.account_id = opengeni_private.current_account_id()
        AND live.content_archive_state IS NULL;
      IF NOT FOUND THEN
        RETURN 0;
      END IF;
      -- Writers and readers hold this lock shared for their whole transaction.
      IF NOT pg_try_advisory_xact_lock(
          hashtextextended('session-content-blobs:' || p_session_id::text, 0)) THEN
        RETURN 0;
      END IF;
      -- A new statement, so it sees every writer that committed before the lock.
      WITH referenced AS (
        SELECT ref.digest
        FROM session_attempt_model_context_snapshots snapshot_row
        CROSS JOIN LATERAL (
          SELECT snapshot_row.content_refs->>'instructions'
          UNION ALL SELECT snapshot_row.content_refs->>'layers'
          UNION ALL SELECT snapshot_row.content_refs->>'tools'
          UNION ALL SELECT snapshot_row.content_refs->>'skills'
          UNION ALL SELECT jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(snapshot_row.content_refs->'body') = 'array'
              THEN snapshot_row.content_refs->'body' ELSE '[]'::jsonb END)
        ) AS ref(digest)
        WHERE snapshot_row.workspace_id = p_workspace_id
          AND snapshot_row.session_id = p_session_id
          AND snapshot_row.content_refs IS NOT NULL
        UNION
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(catalog_row.content_refs->'entries') = 'array'
            THEN catalog_row.content_refs->'entries' ELSE '[]'::jsonb END)
        FROM session_attempt_tool_catalogs catalog_row
        WHERE catalog_row.workspace_id = p_workspace_id
          AND catalog_row.session_id = p_session_id
          AND catalog_row.content_refs IS NOT NULL
      ),
      doomed AS (
        SELECT blob.digest
        FROM session_content_blobs blob
        WHERE blob.workspace_id = p_workspace_id
          AND blob.session_id = p_session_id
          AND blob.created_at < v_before
          AND NOT EXISTS (SELECT 1 FROM referenced WHERE referenced.digest = blob.digest)
        LIMIT v_batch
      )
      DELETE FROM session_content_blobs blob
      USING doomed
      WHERE blob.workspace_id = p_workspace_id
        AND blob.session_id = p_session_id
        AND blob.digest = doomed.digest;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
      IF v_deleted < v_batch THEN
        INSERT INTO opengeni_private.session_content_collections AS collection
          (data_schema, session_id, workspace_id, collected_before)
        VALUES (%1$L, p_session_id, p_workspace_id, v_before)
        ON CONFLICT (data_schema, session_id) DO UPDATE
          SET collected_before = greatest(collection.collected_before, EXCLUDED.collected_before),
            updated_at = pg_catalog.now();
      END IF;
      RETURN v_deleted;
    END
    $body$
  $definition$, data_schema);
END
$session_content_blob_collection$;

REVOKE ALL ON FUNCTION opengeni_private.session_content_garbage_candidates_v1(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.collect_session_content_garbage_v1(uuid, uuid, integer)
  FROM PUBLIC;
