-- OPE-44: session list reads are serializable and subject-scoped. Performing a
-- global expired-row delete inside every read makes concurrent API replicas
-- conflict on the same rows. Move TTL cleanup to one bounded SKIP LOCKED
-- reaper operation and keep the request transaction strictly request-local.

CREATE INDEX "session_list_snapshots_expiry_reaper_idx"
  ON "session_list_snapshots" ("expires_at", "id");

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.reap_expired_session_list_snapshots(p_limit integer)
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE deleted_count integer;
    BEGIN
      WITH victims AS (
        SELECT s.id
        FROM %1$I.session_list_snapshots s
        WHERE s.expires_at < now()
        ORDER BY s.expires_at, s.id
        FOR UPDATE SKIP LOCKED
        LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
      ), deleted AS (
        DELETE FROM %1$I.session_list_snapshots s
        USING victims
        WHERE s.id = victims.id
        RETURNING s.id
      )
      SELECT count(*)::integer INTO deleted_count FROM deleted;
      RETURN deleted_count;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.reap_expired_session_list_snapshots(integer) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.reap_expired_session_list_snapshots(integer)
      TO opengeni_app;
  END IF;
END $$;
