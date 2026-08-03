-- tracking-50: replace the blind periodic scan of "enrollable" sessions with a
-- transactional, revisioned, coalescing delivery ledger. Postgres is the
-- durable work source; a Temporal signal is an idempotent nudge.

CREATE TABLE "session_workflow_wake_outbox" (
  "session_id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "temporal_workflow_id" text NOT NULL,
  "wake_revision" bigint NOT NULL DEFAULT 1,
  "delivered_revision" bigint NOT NULL DEFAULT 0,
  "reason" text NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_workflow_wake_outbox_revision_check"
    CHECK ("wake_revision" > 0 AND "delivered_revision" >= 0
      AND "delivered_revision" <= "wake_revision"),
  CONSTRAINT "session_workflow_wake_outbox_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_workflow_wake_outbox_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "session_workflow_wake_outbox_workspace_session_uq"
  ON "session_workflow_wake_outbox" ("workspace_id", "session_id");
CREATE INDEX "session_workflow_wake_outbox_pending_idx"
  ON "session_workflow_wake_outbox" ("next_attempt_at", "updated_at", "session_id")
  WHERE "wake_revision" > "delivered_revision";

ALTER TABLE "session_workflow_wake_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_workflow_wake_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_workflow_wake_outbox"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Workspace control retries now persist the exact control deliveries they own.
-- Canonicalize pre-cutover receipts once so runtime code has one result shape;
-- any still-pending historical control is independently seeded below.
UPDATE "runtime_control_operations"
SET "result" = jsonb_set("result", '{controls}', '[]'::jsonb, true)
WHERE "scope" = 'workspace'
  AND jsonb_typeof("result") = 'object'
  AND NOT ("result" ? 'controls');

-- Claim only committed revisions that still need delivery. The due timestamp
-- is advanced before delivery, so a process death becomes retryable after the
-- bounded backoff. Acknowledgements are revision-scoped: an old delivery can
-- never hide a newer committed wake.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_session_workflow_wakes(p_limit integer)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      temporal_workflow_id text,
      wake_revision bigint,
      control_event_id uuid
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RETURN QUERY
        WITH due AS (
          SELECT o.session_id
          FROM %1$I.session_workflow_wake_outbox o
          WHERE o.wake_revision > o.delivered_revision
            AND o.next_attempt_at <= now()
          ORDER BY o.next_attempt_at, o.updated_at, o.session_id
          FOR UPDATE SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
        )
        UPDATE %1$I.session_workflow_wake_outbox o
        SET attempts = o.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(o.attempts, 8))::integer))
            ),
            updated_at = now()
        FROM due
        WHERE o.session_id = due.session_id
        RETURNING o.account_id, o.workspace_id, o.session_id,
          o.temporal_workflow_id, o.wake_revision,
          (SELECT s.pending_control_event_id FROM %1$I.sessions s WHERE s.id = o.session_id)
            AS control_event_id;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer) FROM PUBLIC;

-- One-time cutover seed. This is intentionally the final use of an eligibility
-- scan: it converts already-committed pre-outbox work into explicit revisions.
-- Runtime repair after this migration reads only the outbox.
INSERT INTO "session_workflow_wake_outbox" (
  "session_id", "account_id", "workspace_id", "temporal_workflow_id", "reason"
)
SELECT DISTINCT
  s."id",
  s."account_id",
  s."workspace_id",
  coalesce(s."temporal_workflow_id", 'session-' || s."id"::text),
  'cutover_seed'
FROM "sessions" s
JOIN "workspaces" w ON w."id" = s."workspace_id"
WHERE
  s."pending_control_event_id" IS NOT NULL
  OR (
    s."control_state" = 'active'
    AND (
      w."inference_state" = 'active'
      OR s."workspace_run_exception_generation" = w."inference_generation"
    )
    AND (
      EXISTS (
        SELECT 1 FROM "session_turns" t
        WHERE t."workspace_id" = s."workspace_id"
          AND t."session_id" = s."id"
          AND t."status" IN ('queued', 'recovering', 'waiting_capacity', 'requires_action')
      )
      OR EXISTS (
        SELECT 1 FROM "session_system_updates" u
        WHERE u."workspace_id" = s."workspace_id"
          AND u."session_id" = s."id"
          AND u."state" = 'pending'
      )
      OR EXISTS (
        SELECT 1 FROM "session_goals" g
        WHERE g."workspace_id" = s."workspace_id"
          AND g."session_id" = s."id"
          AND g."status" = 'active'
      )
      OR s."compact_requested" = true
    )
  );

DROP FUNCTION opengeni_private.list_enrollable_sessions(integer);

DO $$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_workflow_wake_outbox TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_session_workflow_wakes(integer)
      TO opengeni_app;
  END IF;
END $$;
