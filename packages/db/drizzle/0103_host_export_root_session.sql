-- Preserve immutable session lineage in durable host exports. The outbox owns
-- the captured root so a later session deletion cannot change an unacknowledged
-- export. Legacy rows whose source session is already gone remain explicitly
-- unresolved (NULL) instead of guessing.

ALTER TABLE "host_export_outbox"
  ADD COLUMN IF NOT EXISTS "root_session_id" uuid;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.host_export_session_root(
      p_workspace_id uuid,
      p_session_id uuid
    ) RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_root_id uuid;
      v_parent_id uuid;
      v_depth integer;
      v_cycle boolean;
    BEGIN
      IF p_session_id IS NULL THEN
        RETURN NULL;
      END IF;
      WITH RECURSIVE lineage(id, parent_session_id, depth, path, cycle) AS (
        SELECT s.id, s.parent_session_id, 0, ARRAY[s.id], false
        FROM %1$I.sessions s
        WHERE s.workspace_id = p_workspace_id AND s.id = p_session_id
        UNION ALL
        SELECT parent.id, parent.parent_session_id, lineage.depth + 1,
          lineage.path || parent.id, parent.id = ANY(lineage.path)
        FROM %1$I.sessions parent
        JOIN lineage ON lineage.parent_session_id = parent.id
        WHERE parent.workspace_id = p_workspace_id
          AND NOT lineage.cycle
          AND lineage.depth < 64
      )
      SELECT id, parent_session_id, depth, cycle
      INTO v_root_id, v_parent_id, v_depth, v_cycle
      FROM lineage
      ORDER BY depth DESC
      LIMIT 1;

      IF v_root_id IS NULL THEN
        RETURN NULL;
      END IF;
      IF v_cycle OR v_parent_id IS NOT NULL OR v_depth >= 64 THEN
        RAISE EXCEPTION 'session lineage for %% has no valid workspace root', p_session_id
          USING ERRCODE = '23514';
      END IF;
      RETURN v_root_id;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.capture_host_export_root_session()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      NEW.root_session_id := opengeni_private.host_export_session_root(
        NEW.workspace_id,
        NEW.session_id
      );
      IF NEW.session_id IS NOT NULL AND NEW.root_session_id IS NULL THEN
        RAISE EXCEPTION 'host export session %% does not exist in workspace %%',
          NEW.session_id, NEW.workspace_id
          USING ERRCODE = '23503';
      END IF;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END $migration$;

DROP TRIGGER IF EXISTS host_export_outbox_capture_root_session
  ON "host_export_outbox";
CREATE TRIGGER host_export_outbox_capture_root_session
BEFORE INSERT ON "host_export_outbox"
FOR EACH ROW EXECUTE FUNCTION
  opengeni_private.capture_host_export_root_session();

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.host_export_cursor_roots(
      p_export_kind text,
      p_consumer_id text,
      p_lease_token uuid
    ) RETURNS TABLE (export_cursor bigint, root_session_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
    BEGIN
      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind
        AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND
        OR v_consumer.lease_token IS DISTINCT FROM p_lease_token
        OR v_consumer.lease_from IS NULL
        OR v_consumer.lease_through IS NULL
        OR v_consumer.lease_expires_at IS NULL
        OR v_consumer.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'host export lease is not current'
          USING ERRCODE = '55000';
      END IF;

      RETURN QUERY
      SELECT o.export_cursor, o.root_session_id
      FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind
        AND o.export_cursor > v_consumer.lease_from
        AND o.export_cursor <= v_consumer.lease_through
      ORDER BY o.export_cursor;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION
  opengeni_private.host_export_session_root(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.capture_host_export_root_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_host_export.host_export_cursor_roots(text, text, uuid) FROM PUBLIC;

-- Preserve already-provisioned exporter identities during migration-only
-- upgrades. Exporter role names are host-configurable, so copy the explicit
-- EXECUTE grantees from the canonical claim function instead of assuming a
-- role name. The function owner and PUBLIC are deliberately excluded.
DO $migration$
DECLARE v_role name;
BEGIN
  FOR v_role IN
    SELECT grantee.rolname
    FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        proc.proacl,
        pg_catalog.acldefault('f', proc.proowner)
      )
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE proc.oid =
      'opengeni_host_export.claim_host_export_batch(text, text, uuid, text, integer, integer, integer)'::regprocedure
      AND privilege.grantee <> proc.proowner
      AND privilege.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_host_export.host_export_cursor_roots(text, text, uuid) TO %I',
      v_role
    );
  END LOOP;
END $migration$;

-- Keep data conversion last: no later table/function DDL should run while a
-- populated database may have pending constraint triggers from this update.
WITH distinct_sessions AS MATERIALIZED (
  SELECT DISTINCT "workspace_id", "session_id"
  FROM "host_export_outbox"
  WHERE "session_id" IS NOT NULL
    AND "root_session_id" IS NULL
), resolved_roots AS MATERIALIZED (
  SELECT
    "workspace_id",
    "session_id",
    opengeni_private.host_export_session_root(
      "workspace_id",
      "session_id"
    ) AS "root_session_id"
  FROM distinct_sessions
)
UPDATE "host_export_outbox" o
SET "root_session_id" = roots."root_session_id"
FROM resolved_roots roots
WHERE o."workspace_id" = roots."workspace_id"
  AND o."session_id" = roots."session_id"
  AND o."root_session_id" IS NULL;
