-- deployment-mode: rolling
-- A workspace cascade cannot atomically delete its external Temporal schedules.
-- Persist that ownership before the cascade, then let any API replica claim and
-- settle the idempotent delete. The row intentionally has no workspace/account
-- FK: surviving deletion of those parents is its entire purpose.

CREATE TABLE "temporal_schedule_cleanup_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "temporal_schedule_id" text NOT NULL,
  "claim_id" uuid,
  "claim_until" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "temporal_schedule_cleanup_outbox_valid_chk" CHECK (
    length("temporal_schedule_id") BETWEEN 1 AND 512
    AND "attempt_count" >= 0
    AND (("claim_id" IS NULL AND "claim_until" IS NULL)
      OR ("claim_id" IS NOT NULL AND "claim_until" IS NOT NULL))
    AND ("last_error" IS NULL OR length("last_error") <= 2000)
  )
);

CREATE UNIQUE INDEX "temporal_schedule_cleanup_outbox_schedule_uq"
  ON "temporal_schedule_cleanup_outbox" ("temporal_schedule_id");
CREATE INDEX "temporal_schedule_cleanup_outbox_due_idx"
  ON "temporal_schedule_cleanup_outbox" (
    "next_attempt_at", "claim_until", "id"
  );

ALTER TABLE "temporal_schedule_cleanup_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "temporal_schedule_cleanup_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "temporal_schedule_cleanup_outbox"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_temporal_schedule_cleanups(
      p_claim_id uuid,
      p_limit integer,
      p_claim_seconds integer
    )
    RETURNS TABLE (
      id uuid,
      account_id uuid,
      workspace_id uuid,
      temporal_schedule_id text,
      attempt_count integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_claim_id IS NULL THEN
        RAISE EXCEPTION 'temporal schedule cleanup claim id is required'
          USING ERRCODE = '22023';
      END IF;

      RETURN QUERY
        WITH due AS (
          SELECT cleanup.id
          FROM %1$I.temporal_schedule_cleanup_outbox cleanup
          WHERE cleanup.next_attempt_at <= pg_catalog.now()
            AND (
              cleanup.claim_until IS NULL
              OR cleanup.claim_until <= pg_catalog.now()
            )
          ORDER BY cleanup.next_attempt_at, cleanup.created_at, cleanup.id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 32), 100))
        )
        UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
        SET claim_id = p_claim_id,
            claim_until = pg_catalog.now() + pg_catalog.make_interval(
              secs => greatest(
                5,
                least(coalesce(p_claim_seconds, 15), 300)
              )
            ),
            attempt_count = cleanup.attempt_count + 1,
            updated_at = pg_catalog.now()
        FROM due
        WHERE cleanup.id = due.id
        RETURNING cleanup.id, cleanup.account_id, cleanup.workspace_id,
          cleanup.temporal_schedule_id, cleanup.attempt_count;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.claim_temporal_schedule_cleanups(uuid, integer, integer)
  FROM PUBLIC;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.settle_temporal_schedule_cleanup(
      p_id uuid,
      p_claim_id uuid,
      p_error text
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE settled_rows bigint := 0;
    BEGIN
      IF p_id IS NULL OR p_claim_id IS NULL THEN
        RAISE EXCEPTION 'temporal schedule cleanup id and claim id are required'
          USING ERRCODE = '22023';
      END IF;

      IF p_error IS NULL THEN
        DELETE FROM %1$I.temporal_schedule_cleanup_outbox cleanup
        WHERE cleanup.id = p_id AND cleanup.claim_id = p_claim_id;
        GET DIAGNOSTICS settled_rows = ROW_COUNT;
        RETURN settled_rows = 1;
      END IF;

      UPDATE %1$I.temporal_schedule_cleanup_outbox cleanup
      SET claim_id = NULL,
          claim_until = NULL,
          next_attempt_at = pg_catalog.now() + pg_catalog.make_interval(
            secs => least(
              300,
              greatest(
                1,
                pg_catalog.power(2, least(cleanup.attempt_count - 1, 8))::integer
              )
            )
          ),
          last_error = pg_catalog.left(p_error, 2000),
          updated_at = pg_catalog.now()
      WHERE cleanup.id = p_id AND cleanup.claim_id = p_claim_id;
      GET DIAGNOSTICS settled_rows = ROW_COUNT;
      RETURN settled_rows = 1;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.settle_temporal_schedule_cleanup(uuid, uuid, text)
  FROM PUBLIC;

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.temporal_schedule_cleanup_outbox TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_temporal_schedule_cleanups(uuid, integer, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.settle_temporal_schedule_cleanup(uuid, uuid, text)
      TO opengeni_app;
  END IF;
END $$;
