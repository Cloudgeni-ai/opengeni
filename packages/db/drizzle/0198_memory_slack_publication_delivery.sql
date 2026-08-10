-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '30s';

CREATE TABLE "memory_slack_publication_configurations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL,
  "enabled" boolean NOT NULL,
  "connection_id" uuid,
  "slack_team_id" text,
  "slack_channel_id" text,
  "slack_channel_name" text,
  "auto_importances" text[] NOT NULL DEFAULT ARRAY['major']::text[],
  "review_importances" text[] NOT NULL DEFAULT ARRAY['normal']::text[],
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memory_slack_publication_configurations_workspace_revision_uq"
    UNIQUE ("workspace_id", "revision"),
  CONSTRAINT "memory_slack_publication_configurations_revision_check"
    CHECK ("revision" > 0),
  CONSTRAINT "memory_slack_publication_configurations_destination_check"
    CHECK (
      NOT "enabled"
      OR (
        "connection_id" IS NOT NULL
        AND octet_length("slack_team_id") BETWEEN 1 AND 64
        AND octet_length("slack_channel_id") BETWEEN 1 AND 64
      )
    ),
  CONSTRAINT "memory_slack_publication_configurations_channel_name_check"
    CHECK (
      "slack_channel_name" IS NULL
      OR octet_length("slack_channel_name") BETWEEN 1 AND 256
    ),
  CONSTRAINT "memory_slack_publication_configurations_policy_check"
    CHECK (
      "auto_importances" <@ ARRAY['major', 'normal', 'minor']::text[]
      AND "review_importances" <@ ARRAY['major', 'normal', 'minor']::text[]
      AND cardinality("auto_importances") <= 3
      AND cardinality("review_importances") <= 3
      AND NOT ("auto_importances" && "review_importances")
    ),
  CONSTRAINT "memory_slack_publication_configurations_actor_check"
    CHECK (octet_length("created_by_subject_id") BETWEEN 1 AND 1024)
);

CREATE INDEX "memory_slack_publication_configurations_workspace_created_idx"
  ON "memory_slack_publication_configurations" ("workspace_id", "revision" DESC);

CREATE TABLE "memory_slack_publications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "configuration_id" uuid NOT NULL REFERENCES "memory_slack_publication_configurations"("id") ON DELETE RESTRICT,
  "configuration_revision" integer NOT NULL,
  "connection_id" uuid NOT NULL,
  "slack_team_id" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" text NOT NULL,
  "source_version" text,
  "source_idempotency_key" text NOT NULL,
  "projection" jsonb NOT NULL,
  "projection_sha256" text NOT NULL,
  "importance" text NOT NULL,
  "delivery_mode" text NOT NULL,
  "state" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "initiator_kind" text NOT NULL,
  "initiator_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "session_id" uuid,
  "turn_id" uuid,
  "attempt_id" uuid,
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "retry_at" timestamptz,
  "last_error_code" text,
  "slack_message_timestamp" text,
  "delivered_at" timestamptz,
  "terminal_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memory_slack_publications_source_uq"
    UNIQUE ("workspace_id", "source_idempotency_key"),
  CONSTRAINT "memory_slack_publications_operation_uq"
    UNIQUE ("workspace_id", "operation_id"),
  CONSTRAINT "memory_slack_publications_source_type_check"
    CHECK ("source_type" IN ('workspace_memory', 'durable_learning')),
  CONSTRAINT "memory_slack_publications_source_check"
    CHECK (
      octet_length("source_id") BETWEEN 1 AND 1024
      AND ("source_version" IS NULL OR octet_length("source_version") BETWEEN 1 AND 512)
      AND octet_length("source_idempotency_key") BETWEEN 1 AND 256
    ),
  CONSTRAINT "memory_slack_publications_projection_check"
    CHECK (
      jsonb_typeof("projection") = 'object'
      AND octet_length("projection"::text) BETWEEN 2 AND 8192
      AND "projection_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "memory_slack_publications_distribution_check"
    CHECK (
      "importance" IN ('major', 'normal', 'minor')
      AND "delivery_mode" IN ('auto', 'review')
    ),
  CONSTRAINT "memory_slack_publications_state_check"
    CHECK (
      "state" IN (
        'review_pending', 'queued', 'delivering', 'retry_wait',
        'delivered', 'rejected', 'failed', 'cancelled'
      )
    ),
  CONSTRAINT "memory_slack_publications_destination_check"
    CHECK (
      "configuration_revision" > 0
      AND octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_channel_id") BETWEEN 1 AND 64
    ),
  CONSTRAINT "memory_slack_publications_initiator_check"
    CHECK (
      "initiator_kind" IN ('human', 'agent', 'service')
      AND octet_length("initiator_subject_id") BETWEEN 1 AND 1024
      AND (
        "initiating_human_subject_id" IS NULL
        OR octet_length("initiating_human_subject_id") BETWEEN 1 AND 1024
      )
    ),
  CONSTRAINT "memory_slack_publications_claim_check"
    CHECK (
      ("state" = 'delivering' AND "claim_holder_id" IS NOT NULL AND "claim_expires_at" IS NOT NULL AND "retry_at" IS NULL)
      OR ("state" = 'retry_wait' AND "claim_holder_id" IS NULL AND "claim_expires_at" IS NULL AND "retry_at" IS NOT NULL)
      OR ("state" NOT IN ('delivering', 'retry_wait') AND "claim_holder_id" IS NULL AND "claim_expires_at" IS NULL AND "retry_at" IS NULL)
    ),
  CONSTRAINT "memory_slack_publications_attempt_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "memory_slack_publications_error_check"
    CHECK (
      "last_error_code" IS NULL
      OR octet_length("last_error_code") BETWEEN 1 AND 128
    ),
  CONSTRAINT "memory_slack_publications_terminal_check"
    CHECK (
      (
        "state" = 'delivered'
        AND "claim_holder_id" IS NULL
        AND "claim_expires_at" IS NULL
        AND "retry_at" IS NULL
        AND "slack_message_timestamp" IS NOT NULL
        AND "delivered_at" IS NOT NULL
        AND "terminal_at" IS NOT NULL
      )
      OR (
        "state" IN ('rejected', 'failed', 'cancelled')
        AND "claim_holder_id" IS NULL
        AND "claim_expires_at" IS NULL
        AND "retry_at" IS NULL
        AND "terminal_at" IS NOT NULL
      )
      OR (
        "state" NOT IN ('delivered', 'rejected', 'failed', 'cancelled')
        AND "slack_message_timestamp" IS NULL
        AND "delivered_at" IS NULL
        AND "terminal_at" IS NULL
      )
    )
);

CREATE INDEX "memory_slack_publications_claim_idx"
  ON "memory_slack_publications" ("state", "retry_at", "created_at", "id")
  WHERE "state" IN ('queued', 'retry_wait', 'delivering');

CREATE INDEX "memory_slack_publications_workspace_history_idx"
  ON "memory_slack_publications" ("workspace_id", "created_at" DESC, "id" DESC);

CREATE TABLE "memory_slack_publication_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "publication_id" uuid NOT NULL REFERENCES "memory_slack_publications"("id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "attempt_number" integer NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "error_code" text,
  "retry_at" timestamptz,
  "slack_channel_id" text,
  "slack_message_timestamp" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "memory_slack_publication_receipts_sequence_uq"
    UNIQUE ("publication_id", "sequence"),
  CONSTRAINT "memory_slack_publication_receipts_kind_check"
    CHECK (
      "kind" IN (
        'enqueued', 'review_approved', 'review_rejected', 'delivery_claimed',
        'retry_scheduled', 'delivered', 'failed', 'cancelled', 'manual_retry'
      )
    ),
  CONSTRAINT "memory_slack_publication_receipts_state_check"
    CHECK (
      "state" IN (
        'review_pending', 'queued', 'delivering', 'retry_wait',
        'delivered', 'rejected', 'failed', 'cancelled'
      )
    ),
  CONSTRAINT "memory_slack_publication_receipts_attempt_check"
    CHECK ("sequence" > 0 AND "attempt_number" >= 0),
  CONSTRAINT "memory_slack_publication_receipts_actor_check"
    CHECK (
      "actor_kind" IN ('human', 'agent', 'service')
      AND octet_length("actor_subject_id") BETWEEN 1 AND 1024
    ),
  CONSTRAINT "memory_slack_publication_receipts_error_check"
    CHECK ("error_code" IS NULL OR octet_length("error_code") BETWEEN 1 AND 128),
  CONSTRAINT "memory_slack_publication_receipts_provider_check"
    CHECK (
      ("slack_channel_id" IS NULL) = ("slack_message_timestamp" IS NULL)
      AND ("slack_channel_id" IS NULL OR octet_length("slack_channel_id") BETWEEN 1 AND 64)
      AND (
        "slack_message_timestamp" IS NULL
        OR octet_length("slack_message_timestamp") BETWEEN 1 AND 64
      )
    )
);

CREATE INDEX "memory_slack_publication_receipts_workspace_history_idx"
  ON "memory_slack_publication_receipts" ("workspace_id", "publication_id", "sequence");

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_memory_slack_publication(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.memory_slack_publications
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid memory Slack publication claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT P.id
        FROM %1$I.memory_slack_publications P
        WHERE (
            P.state = 'queued'
          ) OR (
            P.state = 'retry_wait'
            AND P.retry_at <= now()
          ) OR (
            P.state = 'delivering'
            AND P.claim_expires_at <= now()
          )
        ORDER BY P.retry_at NULLS FIRST, P.created_at, P.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE %1$I.memory_slack_publications P
        SET state = 'delivering',
            claim_holder_id = p_holder,
            claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
            retry_at = NULL,
            attempt_count = P.attempt_count + 1,
            updated_at = now()
        FROM candidate C
        WHERE P.id = C.id
        RETURNING P.*
      ), receipt AS (
        INSERT INTO %1$I.memory_slack_publication_receipts (
          account_id, workspace_id, publication_id, sequence, kind, state,
          attempt_number, actor_kind, actor_subject_id, operation_id
        )
        SELECT
          C.account_id, C.workspace_id, C.id,
          COALESCE((
            SELECT max(R.sequence)
            FROM %1$I.memory_slack_publication_receipts R
            WHERE R.publication_id = C.id
          ), 0) + 1,
          'delivery_claimed', 'delivering', C.attempt_count,
          'service', 'memory-slack-delivery', C.operation_id
        FROM claimed C
        RETURNING publication_id
      )
      SELECT C.*
      FROM claimed C
      JOIN receipt R ON R.publication_id = C.id;
    END
    $function$
  $ddl$, data_schema);
END
$privileged_functions$;

REVOKE ALL ON FUNCTION opengeni_private.claim_memory_slack_publication(uuid, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_memory_slack_publication(uuid, integer)
      TO opengeni_app;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.reject_memory_slack_immutable_mutation()
  FROM PUBLIC;

CREATE TRIGGER memory_slack_publication_configurations_immutable
  BEFORE UPDATE OR DELETE ON "memory_slack_publication_configurations"
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation();

CREATE TRIGGER memory_slack_publication_receipts_immutable
  BEFORE UPDATE OR DELETE ON "memory_slack_publication_receipts"
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation();

CREATE OR REPLACE FUNCTION opengeni_private.guard_memory_slack_publication_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(
    NEW."account_id", NEW."workspace_id", NEW."configuration_id",
    NEW."configuration_revision", NEW."connection_id", NEW."slack_team_id",
    NEW."slack_channel_id", NEW."source_type", NEW."source_id",
    NEW."source_version", NEW."source_idempotency_key", NEW."projection",
    NEW."projection_sha256", NEW."importance", NEW."delivery_mode",
    NEW."operation_id", NEW."initiator_kind", NEW."initiator_subject_id",
    NEW."initiating_human_subject_id", NEW."session_id", NEW."turn_id",
    NEW."attempt_id", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."account_id", OLD."workspace_id", OLD."configuration_id",
    OLD."configuration_revision", OLD."connection_id", OLD."slack_team_id",
    OLD."slack_channel_id", OLD."source_type", OLD."source_id",
    OLD."source_version", OLD."source_idempotency_key", OLD."projection",
    OLD."projection_sha256", OLD."importance", OLD."delivery_mode",
    OLD."operation_id", OLD."initiator_kind", OLD."initiator_subject_id",
    OLD."initiating_human_subject_id", OLD."session_id", OLD."turn_id",
    OLD."attempt_id", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'memory Slack publication identity is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.guard_memory_slack_publication_identity()
  FROM PUBLIC;

CREATE TRIGGER memory_slack_publications_identity_immutable
  BEFORE UPDATE ON "memory_slack_publications"
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_memory_slack_publication_identity();

ALTER TABLE "memory_slack_publication_configurations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_slack_publication_configurations" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "memory_slack_publication_configurations"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "memory_slack_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_slack_publications" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "memory_slack_publications"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

ALTER TABLE "memory_slack_publication_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memory_slack_publication_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "memory_slack_publication_receipts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

RESET statement_timeout;
RESET lock_timeout;