-- deployment-mode: rolling
-- OPE-20: typed durable session waits and provider-neutral background jobs.
-- Postgres owns every state transition; Temporal timers/controllers are
-- replaceable wake machinery and NATS remains best-effort fanout only.

ALTER TABLE "agent_run_states"
  ADD COLUMN "execution_generation" integer,
  ADD COLUMN "attempt_id" uuid;

CREATE INDEX "agent_run_states_attempt_idx"
  ON "agent_run_states" ("workspace_id", "session_id", "turn_id", "execution_generation", "attempt_id")
  WHERE "attempt_id" IS NOT NULL;

CREATE TABLE "background_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "origin_session_id" uuid NOT NULL,
  "origin_turn_id" uuid,
  "wait_id" uuid,
  "provider" text NOT NULL DEFAULT 'modal',
  "spec" jsonb NOT NULL,
  "fire_key" text NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "provider_ref" text,
  "provider_instance_id" text,
  "start_count" integer NOT NULL DEFAULT 0,
  "cancel_requested_at" timestamptz,
  "exit_code" integer,
  "error" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "background_jobs_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "background_jobs_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "origin_session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "background_jobs_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "origin_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "background_jobs_provider_check" CHECK ("provider" IN ('modal')),
  CONSTRAINT "background_jobs_status_check" CHECK (
    "status" IN ('queued','starting','running','cancelling','completed','failed','cancelled','lost')
  ),
  CONSTRAINT "background_jobs_start_count_check" CHECK ("start_count" BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX "background_jobs_workspace_id_uq"
  ON "background_jobs" ("workspace_id", "id");
CREATE UNIQUE INDEX "background_jobs_workspace_fire_key_uq"
  ON "background_jobs" ("workspace_id", "fire_key");
CREATE INDEX "background_jobs_workspace_status_idx"
  ON "background_jobs" ("workspace_id", "status", "updated_at");
CREATE INDEX "background_jobs_origin_idx"
  ON "background_jobs" ("workspace_id", "origin_session_id", "created_at");

CREATE TABLE "background_job_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "attempt_number" integer NOT NULL,
  "controller_id" text,
  "provider_ref" text,
  "provider_instance_id" text,
  "status" text NOT NULL DEFAULT 'observing',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "background_job_attempts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "background_job_attempts_workspace_job_fk"
    FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "background_jobs"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "background_job_attempts_status_check" CHECK (
    "status" IN ('observing','completed','failed','cancelled','lost')
  ),
  CONSTRAINT "background_job_attempts_number_check" CHECK ("attempt_number" > 0)
);

CREATE UNIQUE INDEX "background_job_attempts_job_attempt_uq"
  ON "background_job_attempts" ("workspace_id", "job_id", "attempt_number");
CREATE UNIQUE INDEX "background_job_attempts_workspace_job_id_uq"
  ON "background_job_attempts" ("workspace_id", "job_id", "id");
CREATE INDEX "background_job_attempts_job_status_idx"
  ON "background_job_attempts" ("workspace_id", "job_id", "status", "created_at");

CREATE TABLE "background_job_log_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "attempt_id" uuid,
  "sequence" integer NOT NULL,
  "provider_offset" bigint NOT NULL,
  "provider_length" bigint NOT NULL,
  "stream" text NOT NULL,
  "text" text NOT NULL,
  "content_hash" text NOT NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "background_job_log_chunks_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "background_job_log_chunks_workspace_job_fk"
    FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "background_jobs"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "background_job_log_chunks_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "job_id", "attempt_id")
    REFERENCES "background_job_attempts"("workspace_id", "job_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "background_job_log_chunks_stream_check"
    CHECK ("stream" IN ('stdout','stderr','system')),
  CONSTRAINT "background_job_log_chunks_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "background_job_log_chunks_offset_check" CHECK ("provider_offset" >= 0),
  CONSTRAINT "background_job_log_chunks_length_check" CHECK ("provider_length" >= 0)
);

CREATE UNIQUE INDEX "background_job_log_chunks_job_sequence_uq"
  ON "background_job_log_chunks" ("workspace_id", "job_id", "sequence");
CREATE UNIQUE INDEX "background_job_log_chunks_job_provider_offset_uq"
  ON "background_job_log_chunks" ("workspace_id", "job_id", "stream", "provider_offset");
CREATE INDEX "background_job_log_chunks_job_occurred_idx"
  ON "background_job_log_chunks" ("workspace_id", "job_id", "occurred_at");

CREATE TABLE "background_job_dispatches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "dispatch_key" text NOT NULL,
  "workflow_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'requested',
  "attempt_id" uuid,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "background_job_dispatches_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "background_job_dispatches_workspace_job_fk"
    FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "background_jobs"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "background_job_dispatches_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "job_id", "attempt_id")
    REFERENCES "background_job_attempts"("workspace_id", "job_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "background_job_dispatches_status_check"
    CHECK ("status" IN ('requested','started','completed','failed')),
  CONSTRAINT "background_job_dispatches_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "background_job_dispatches_job_key_uq"
  ON "background_job_dispatches" ("workspace_id", "job_id", "dispatch_key");
CREATE INDEX "background_job_dispatches_due_idx"
  ON "background_job_dispatches" ("status", "next_attempt_at", "updated_at")
  WHERE "status" = 'requested';

CREATE TABLE "background_job_artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "path" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "background_job_artifacts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "background_job_artifacts_workspace_job_fk"
    FOREIGN KEY ("workspace_id", "job_id")
    REFERENCES "background_jobs"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "background_job_artifacts_size_check" CHECK ("size_bytes" >= 0)
);

CREATE UNIQUE INDEX "background_job_artifacts_job_path_uq"
  ON "background_job_artifacts" ("workspace_id", "job_id", "path");

CREATE TABLE "durable_waits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "origin_turn_id" uuid,
  "execution_generation" integer,
  "attempt_id" uuid,
  "approval_id" text,
  "kind" text NOT NULL,
  "request_key" text NOT NULL,
  "request" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "state" text NOT NULL DEFAULT 'waiting',
  "outcome" text,
  "resolution" jsonb,
  "wake_at" timestamptz,
  "next_reminder_at" timestamptz,
  "reminder_interval_seconds" integer,
  "reminder_sequence" integer NOT NULL DEFAULT 0,
  "event_source_identity" text,
  "event_type" text,
  "event_subject" text,
  "event_correlation_key" text,
  "background_job_id" uuid,
  "answer_client_event_id" text,
  "resolution_event_id" uuid,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_waits_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "durable_waits_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "durable_waits_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "origin_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_waits_workspace_attempt_fk"
    FOREIGN KEY ("workspace_id", "attempt_id")
    REFERENCES "session_turn_attempts"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_waits_workspace_job_fk"
    FOREIGN KEY ("workspace_id", "background_job_id")
    REFERENCES "background_jobs"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_waits_kind_check"
    CHECK ("kind" IN ('ask_user','until','event','background_job')),
  CONSTRAINT "durable_waits_state_check" CHECK ("state" IN ('waiting','resolved')),
  CONSTRAINT "durable_waits_outcome_check" CHECK (
    "outcome" IS NULL OR "outcome" IN (
      'answered','time_reached','event_received','completed','failed','cancelled','lost','timed_out'
    )
  ),
  CONSTRAINT "durable_waits_state_outcome_check" CHECK (
    ("state" = 'waiting' AND "outcome" IS NULL AND "resolved_at" IS NULL)
    OR ("state" = 'resolved' AND "outcome" IS NOT NULL AND "resolved_at" IS NOT NULL)
  ),
  CONSTRAINT "durable_waits_reminder_check" CHECK (
    "reminder_interval_seconds" IS NULL OR "reminder_interval_seconds" > 0
  ),
  CONSTRAINT "durable_waits_shape_check" CHECK (
    ("kind" = 'ask_user'
      AND "origin_turn_id" IS NOT NULL
      AND "execution_generation" IS NOT NULL
      AND "attempt_id" IS NOT NULL
      AND "approval_id" IS NOT NULL
      AND "background_job_id" IS NULL)
    OR ("kind" = 'until'
      AND "origin_turn_id" IS NOT NULL
      AND "execution_generation" IS NOT NULL
      AND "attempt_id" IS NOT NULL
      AND "wake_at" IS NOT NULL
      AND "approval_id" IS NULL
      AND "background_job_id" IS NULL)
    OR ("kind" = 'event'
      AND "origin_turn_id" IS NOT NULL
      AND "execution_generation" IS NOT NULL
      AND "attempt_id" IS NOT NULL
      AND "event_source_identity" IS NOT NULL
      AND "event_type" IS NOT NULL
      AND "event_correlation_key" IS NOT NULL
      AND "approval_id" IS NULL
      AND "background_job_id" IS NULL)
    OR ("kind" = 'background_job'
      AND "origin_turn_id" IS NOT NULL
      AND "execution_generation" IS NOT NULL
      AND "attempt_id" IS NOT NULL
      AND "background_job_id" IS NOT NULL
      AND "approval_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "durable_waits_workspace_id_uq"
  ON "durable_waits" ("workspace_id", "id");
CREATE UNIQUE INDEX "durable_waits_session_request_key_uq"
  ON "durable_waits" ("workspace_id", "session_id", "request_key");
CREATE UNIQUE INDEX "durable_waits_session_approval_uq"
  ON "durable_waits" ("workspace_id", "session_id", "approval_id")
  WHERE "approval_id" IS NOT NULL;
CREATE UNIQUE INDEX "durable_waits_answer_event_uq"
  ON "durable_waits" ("workspace_id", "session_id", "answer_client_event_id")
  WHERE "answer_client_event_id" IS NOT NULL;
CREATE UNIQUE INDEX "durable_waits_background_job_uq"
  ON "durable_waits" ("workspace_id", "background_job_id")
  WHERE "background_job_id" IS NOT NULL;
CREATE INDEX "durable_waits_session_state_idx"
  ON "durable_waits" ("workspace_id", "session_id", "state", "wake_at", "created_at");
CREATE INDEX "durable_waits_event_match_idx"
  ON "durable_waits" (
    "workspace_id", "event_source_identity", "event_type",
    "event_correlation_key", "state", "created_at"
  ) WHERE "kind" = 'event';

ALTER TABLE "background_jobs"
  ADD CONSTRAINT "background_jobs_workspace_wait_fk"
  FOREIGN KEY ("workspace_id", "wait_id")
  REFERENCES "durable_waits"("workspace_id", "id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "background_jobs_workspace_wait_uq"
  ON "background_jobs" ("workspace_id", "wait_id") WHERE "wait_id" IS NOT NULL;

CREATE TABLE "durable_wait_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "source_identity" text NOT NULL,
  "event_id" text NOT NULL,
  "content_hash" text NOT NULL,
  "type" text NOT NULL,
  "subject" text,
  "correlation_key" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "state" text NOT NULL DEFAULT 'accepted',
  "matched_wait_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_wait_events_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "durable_wait_events_workspace_wait_fk"
    FOREIGN KEY ("workspace_id", "matched_wait_id")
    REFERENCES "durable_waits"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "durable_wait_events_version_check" CHECK ("version" = 1),
  CONSTRAINT "durable_wait_events_state_check" CHECK ("state" IN ('accepted','matched'))
);

CREATE UNIQUE INDEX "durable_wait_events_source_event_uq"
  ON "durable_wait_events" ("workspace_id", "source_identity", "event_id");
CREATE INDEX "durable_wait_events_match_idx"
  ON "durable_wait_events" (
    "workspace_id", "source_identity", "type", "correlation_key", "created_at"
  );

ALTER TABLE "background_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "background_jobs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "background_job_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "background_job_attempts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "background_job_log_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "background_job_log_chunks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "background_job_dispatches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "background_job_dispatches" FORCE ROW LEVEL SECURITY;
ALTER TABLE "background_job_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "background_job_artifacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_waits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_waits" FORCE ROW LEVEL SECURITY;
ALTER TABLE "durable_wait_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "durable_wait_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "background_jobs"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "background_job_attempts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "background_job_log_chunks"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "background_job_dispatches"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "background_job_artifacts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "durable_waits"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE POLICY workspace_isolation ON "durable_wait_events"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Repair commit-to-Temporal-start loss without scanning job-shaped state. The
-- ledger is the only dispatch source and the claim advances a bounded backoff.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.claim_background_job_dispatches(p_limit integer)
    RETURNS TABLE (
      id uuid,
      account_id uuid,
      workspace_id uuid,
      job_id uuid,
      dispatch_key text,
      workflow_id text,
      attempts integer
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      RETURN QUERY
        WITH due AS (
          SELECT d.id
          FROM %1$I.background_job_dispatches d
          JOIN %1$I.background_jobs j
            ON j.workspace_id = d.workspace_id AND j.id = d.job_id
          WHERE d.status = 'requested'
            AND d.next_attempt_at <= now()
            AND j.status IN ('queued','starting','running','cancelling')
          ORDER BY d.next_attempt_at, d.updated_at, d.id
          FOR UPDATE OF d SKIP LOCKED
          LIMIT greatest(1, least(coalesce(p_limit, 100), 1000))
        )
        UPDATE %1$I.background_job_dispatches d
        SET attempts = d.attempts + 1,
            next_attempt_at = now() + make_interval(
              secs => least(300, greatest(1, power(2, least(d.attempts, 8))::integer))
            ),
            updated_at = now()
        FROM due
        WHERE d.id = due.id
        RETURNING d.id, d.account_id, d.workspace_id, d.job_id,
          d.dispatch_key, d.workflow_id, d.attempts;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.claim_background_job_dispatches(integer) FROM PUBLIC;

DO $grant$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.background_jobs, %I.background_job_attempts, %I.background_job_log_chunks, %I.background_job_dispatches, %I.background_job_artifacts, %I.durable_waits, %I.durable_wait_events TO opengeni_app',
      target_schema, target_schema, target_schema, target_schema,
      target_schema, target_schema, target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_background_job_dispatches(integer)
      TO opengeni_app;
  END IF;
END $grant$;