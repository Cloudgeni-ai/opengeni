-- deployment-mode: rolling
-- Generic durable host export: source-atomic bounded snapshots, post-commit
-- cursors, and named at-least-once consumer checkpoints. Standalone remains
-- disabled until a host registers a consumer.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "session_id" uuid,
  ADD COLUMN IF NOT EXISTS "turn_id" uuid,
  ADD COLUMN IF NOT EXISTS "turn_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "initiator_kind" text,
  ADD COLUMN IF NOT EXISTS "initiator_subject_id" text,
  ADD COLUMN IF NOT EXISTS "initiator_context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "origin" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_context_hierarchy_check'
      AND conrelid = 'usage_events'::regclass
  ) THEN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_context_hierarchy_check"
      CHECK (("turn_id" IS NULL OR "session_id" IS NOT NULL)
        AND ("turn_attempt_id" IS NULL OR "turn_id" IS NOT NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_initiator_check'
      AND conrelid = 'usage_events'::regclass
  ) THEN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_initiator_check"
      CHECK (("initiator_kind" IS NULL AND "initiator_subject_id" IS NULL)
        OR ("initiator_kind" IN ('subject', 'service')
          AND "initiator_subject_id" IS NOT NULL
          AND octet_length("initiator_subject_id") BETWEEN 1 AND 1024)) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_initiator_context_bytes_check'
      AND conrelid = 'usage_events'::regclass
  ) THEN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_initiator_context_bytes_check"
      CHECK (octet_length("initiator_context"::text) <= 4096) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'usage_events_origin_check'
      AND conrelid = 'usage_events'::regclass
  ) THEN
    ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_origin_check"
      CHECK ("origin" IS NULL OR "origin" IN (
        'user', 'scheduled_task', 'api', 'goal', 'system', 'compaction'
      )) NOT VALID;
  END IF;
END $$;

ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_context_hierarchy_check";
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_initiator_check";
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_initiator_context_bytes_check";
ALTER TABLE "usage_events" VALIDATE CONSTRAINT "usage_events_origin_check";

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.validate_usage_event_execution_context()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      -- Usage is an immutable billing/audit fact. Validate newly supplied
      -- execution identity under row locks, but keep those UUIDs as soft
      -- references after the source session or turn is deleted. An unchanged
      -- idempotent retry after deletion must also remain valid.
      IF TG_OP = 'INSERT'
        OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
        OR NEW.session_id IS DISTINCT FROM OLD.session_id
        OR NEW.turn_id IS DISTINCT FROM OLD.turn_id
        OR NEW.turn_attempt_id IS DISTINCT FROM OLD.turn_attempt_id THEN
        IF NEW.session_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.sessions s
          WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event session does not exist in its workspace'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.turn_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.session_turns t
          WHERE t.workspace_id = NEW.workspace_id
            AND t.session_id = NEW.session_id
            AND t.id = NEW.turn_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event turn does not belong to its session'
              USING ERRCODE = '23514';
          END IF;
        END IF;
        IF NEW.turn_attempt_id IS NOT NULL THEN
          PERFORM 1 FROM %1$I.session_turn_attempts a
          WHERE a.workspace_id = NEW.workspace_id
            AND a.session_id = NEW.session_id
            AND a.turn_id = NEW.turn_id
            AND a.id = NEW.turn_attempt_id
          FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'usage event attempt does not belong to its turn'
              USING ERRCODE = '23514';
          END IF;
        END IF;
      END IF;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END $migration$;

DROP TRIGGER IF EXISTS usage_events_execution_context_guard ON "usage_events";
CREATE TRIGGER usage_events_execution_context_guard
BEFORE INSERT OR UPDATE OF "workspace_id", "session_id", "turn_id", "turn_attempt_id"
ON "usage_events"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.validate_usage_event_execution_context();

CREATE SCHEMA IF NOT EXISTS opengeni_host_export;
REVOKE ALL ON SCHEMA opengeni_host_export FROM PUBLIC;

CREATE TABLE IF NOT EXISTS "host_export_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "session_events_enabled" boolean NOT NULL DEFAULT false,
  "usage_events_enabled" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "host_export_config_singleton_check" CHECK ("id" = 1)
);

INSERT INTO "host_export_config" ("id") VALUES (1)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "host_export_cursor_state" (
  "export_kind" text PRIMARY KEY,
  "next_cursor" bigint NOT NULL DEFAULT 1,
  "pruned_through" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "host_export_cursor_state_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event')),
  CONSTRAINT "host_export_cursor_state_next_check"
    CHECK ("next_cursor" > 0 AND "pruned_through" >= 0
      AND "pruned_through" < "next_cursor")
);

ALTER TABLE "host_export_cursor_state"
  ADD COLUMN IF NOT EXISTS "pruned_through" bigint NOT NULL DEFAULT 0;

INSERT INTO "host_export_cursor_state" ("export_kind")
VALUES ('session_event'), ('usage_event')
ON CONFLICT ("export_kind") DO NOTHING;

CREATE TABLE IF NOT EXISTS "host_export_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "export_kind" text NOT NULL,
  "export_cursor" bigint,
  "source_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid,
  "root_session_id" uuid,
  "turn_id" uuid,
  "turn_generation" integer,
  "turn_attempt_id" uuid,
  "session_sequence" integer,
  "client_event_id" text,
  "turn_association" text,
  "duplicate_of_event_id" uuid,
  "duplicate_reason" text,
  "event_type" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "initiator" jsonb,
  "initiator_context" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "origin" text,
  "payload" jsonb NOT NULL,
  "envelope_bytes" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "source_recorded_at" timestamptz NOT NULL,
  "enqueued_at" timestamptz NOT NULL,
  CONSTRAINT "host_export_outbox_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event')),
  CONSTRAINT "host_export_outbox_cursor_check"
    CHECK ("export_cursor" IS NULL OR "export_cursor" > 0),
  CONSTRAINT "host_export_outbox_sequence_check"
    CHECK ("session_sequence" IS NULL OR "session_sequence" > 0),
  CONSTRAINT "host_export_outbox_envelope_bytes_check"
    CHECK ("envelope_bytes" > 0 AND "envelope_bytes" <= 98304),
  CONSTRAINT "host_export_outbox_payload_bytes_check"
    CHECK (pg_column_size("payload") <= 73728),
  CONSTRAINT "host_export_outbox_initiator_check"
    CHECK (
      "initiator" IS NULL OR (
        jsonb_typeof("initiator") = 'object'
        AND "initiator" ->> 'kind' IN ('subject', 'service')
        AND length("initiator" ->> 'subjectId') > 0
      )
    ),
  CONSTRAINT "host_export_outbox_context_bytes_check"
    CHECK (octet_length("initiator_context"::text) <= 4096),
  CONSTRAINT "host_export_outbox_origin_check"
    CHECK ("origin" IS NULL OR "origin" IN (
      'user', 'scheduled_task', 'api', 'goal', 'system', 'compaction'
    ))
);

ALTER TABLE "host_export_outbox"
  ADD COLUMN IF NOT EXISTS "root_session_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'host_export_outbox_root_session_check'
      AND conrelid = 'host_export_outbox'::regclass
  ) THEN
    ALTER TABLE "host_export_outbox"
      ADD CONSTRAINT "host_export_outbox_root_session_check"
      CHECK ("session_id" IS NULL OR "root_session_id" IS NOT NULL)
      NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "host_export_outbox_source_uq"
  ON "host_export_outbox" ("export_kind", "source_id");
CREATE UNIQUE INDEX IF NOT EXISTS "host_export_outbox_cursor_uq"
  ON "host_export_outbox" ("export_kind", "export_cursor")
  WHERE "export_cursor" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "host_export_outbox_unassigned_idx"
  ON "host_export_outbox" ("export_kind", "enqueued_at", "id")
  WHERE "export_cursor" IS NULL;
CREATE INDEX IF NOT EXISTS "host_export_outbox_unassigned_session_idx"
  ON "host_export_outbox" ("export_kind", "session_id", "session_sequence")
  WHERE "export_cursor" IS NULL AND "session_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "host_export_outbox_cursor_read_idx"
  ON "host_export_outbox" ("export_kind", "export_cursor")
  INCLUDE ("envelope_bytes") WHERE "export_cursor" IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS "host_export_consumers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "consumer_id" text NOT NULL,
  "export_kind" text NOT NULL,
  "checkpoint" bigint NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "lease_token" uuid,
  "lease_holder_id" text,
  "lease_expires_at" timestamptz,
  "lease_from" bigint,
  "lease_through" bigint,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "last_error_at" timestamptz,
  "blocked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "host_export_consumers_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event')),
  CONSTRAINT "host_export_consumers_checkpoint_check" CHECK ("checkpoint" >= 0),
  CONSTRAINT "host_export_consumers_id_check"
    CHECK (
      length("consumer_id") BETWEEN 1 AND 128
      AND "consumer_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ),
  CONSTRAINT "host_export_consumers_lease_check"
    CHECK (
      ("lease_token" IS NULL AND "lease_holder_id" IS NULL
        AND "lease_expires_at" IS NULL AND "lease_from" IS NULL
        AND "lease_through" IS NULL)
      OR
      ("lease_token" IS NOT NULL AND "lease_holder_id" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL AND "lease_from" IS NOT NULL
        AND "lease_through" IS NOT NULL AND "lease_through" > "lease_from")
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "host_export_consumers_kind_id_uq"
  ON "host_export_consumers" ("export_kind", "consumer_id");
CREATE INDEX IF NOT EXISTS "host_export_consumers_due_idx"
  ON "host_export_consumers" ("enabled", "blocked_at", "next_attempt_at");

CREATE TABLE IF NOT EXISTS "host_export_dead_letters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "consumer_id" text NOT NULL,
  "export_kind" text NOT NULL,
  "export_cursor" bigint NOT NULL,
  "source_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "envelope" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "host_export_dead_letters_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event')),
  CONSTRAINT "host_export_dead_letters_reason_check"
    CHECK (length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "host_export_dead_letters_envelope_bytes_check"
    CHECK (pg_column_size("envelope") <= 114688)
);

CREATE UNIQUE INDEX IF NOT EXISTS "host_export_dead_letters_consumer_cursor_uq"
  ON "host_export_dead_letters" ("export_kind", "consumer_id", "export_cursor");

ALTER TABLE "host_export_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_export_config" FORCE ROW LEVEL SECURITY;
ALTER TABLE "host_export_cursor_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_export_cursor_state" FORCE ROW LEVEL SECURITY;
ALTER TABLE "host_export_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_export_outbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "host_export_consumers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_export_consumers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "host_export_dead_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "host_export_dead_letters" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS host_export_system_only ON "host_export_config";
CREATE POLICY host_export_system_only ON "host_export_config" USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS host_export_system_only ON "host_export_cursor_state";
CREATE POLICY host_export_system_only ON "host_export_cursor_state" USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS host_export_system_only ON "host_export_outbox";
CREATE POLICY host_export_system_only ON "host_export_outbox" USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS host_export_system_only ON "host_export_consumers";
CREATE POLICY host_export_system_only ON "host_export_consumers" USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS host_export_system_only ON "host_export_dead_letters";
CREATE POLICY host_export_system_only ON "host_export_dead_letters" USING (false) WITH CHECK (false);

-- FORCE RLS still applies to the table owner. Permit only the exact migration
-- owner (also the SECURITY DEFINER owner below); the runtime app role remains
-- denied even if a later provisioning step grants broad table privileges.
DO $policies$
DECLARE owner_role text := current_user;
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS host_export_owner ON %I.host_export_config', current_schema());
  EXECUTE format(
    'CREATE POLICY host_export_owner ON %I.host_export_config USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_schema(), owner_role, owner_role
  );
  EXECUTE format('DROP POLICY IF EXISTS host_export_owner ON %I.host_export_cursor_state', current_schema());
  EXECUTE format(
    'CREATE POLICY host_export_owner ON %I.host_export_cursor_state USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_schema(), owner_role, owner_role
  );
  EXECUTE format('DROP POLICY IF EXISTS host_export_owner ON %I.host_export_outbox', current_schema());
  EXECUTE format(
    'CREATE POLICY host_export_owner ON %I.host_export_outbox USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_schema(), owner_role, owner_role
  );
  EXECUTE format('DROP POLICY IF EXISTS host_export_owner ON %I.host_export_consumers', current_schema());
  EXECUTE format(
    'CREATE POLICY host_export_owner ON %I.host_export_consumers USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_schema(), owner_role, owner_role
  );
  EXECUTE format('DROP POLICY IF EXISTS host_export_owner ON %I.host_export_dead_letters', current_schema());
  EXECUTE format(
    'CREATE POLICY host_export_owner ON %I.host_export_dead_letters USING (current_user = %L) WITH CHECK (current_user = %L)',
    current_schema(), owner_role, owner_role
  );
END $policies$;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_host_session_event_export()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_initiator jsonb;
      v_context jsonb := '{}'::jsonb;
      v_origin text;
      v_payload_bytes integer;
    BEGIN
      IF NEW.type IN (
        'agent.message.delta', 'agent.reasoning.delta',
        'sandbox.command.output.delta', 'terminal.pty.output.delta'
      ) THEN
        RETURN NEW;
      END IF;

      SELECT c.session_events_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1
      FOR SHARE;
      IF coalesce(v_enabled, false) = false THEN
        RETURN NEW;
      END IF;

      IF NEW.turn_id IS NOT NULL THEN
        SELECT
          CASE WHEN octet_length(t.initiator_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', t.initiator_kind,
              'subjectId', t.initiator_subject_id,
              'label', CASE
                WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
                THEN left(t.initiator_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
              THEN left(t.initiator_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'backfill') = 'boolean'
              THEN t.initiator_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(t.initiator_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          t.source
        INTO v_initiator, v_context, v_origin
        FROM %1$I.session_turns t
        WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.turn_id;
      ELSIF NEW.type = 'session.created' THEN
        SELECT
          CASE WHEN octet_length(s.created_by_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', s.created_by_kind,
              'subjectId', s.created_by_subject_id,
              'label', CASE
                WHEN jsonb_typeof(s.created_by_context -> 'label') = 'string'
                THEN left(s.created_by_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(s.created_by_context -> 'label') = 'string'
              THEN left(s.created_by_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(s.created_by_context -> 'backfill') = 'boolean'
              THEN s.created_by_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(s.created_by_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          NULL
        INTO v_initiator, v_context, v_origin
        FROM %1$I.sessions s
        WHERE s.workspace_id = NEW.workspace_id AND s.id = NEW.session_id;
      END IF;

      v_payload_bytes := octet_length(NEW.payload::text)
        + octet_length(NEW.type)
        + coalesce(octet_length(NEW.client_event_id), 0)
        + coalesce(octet_length(NEW.turn_association), 0)
        + coalesce(octet_length(NEW.duplicate_reason), 0)
        + octet_length(coalesce(v_initiator, 'null'::jsonb)::text)
        + octet_length(v_context::text)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_generation, turn_attempt_id, session_sequence,
        client_event_id, turn_association, duplicate_of_event_id, duplicate_reason,
        event_type, idempotency_key, initiator, initiator_context, origin,
        payload, envelope_bytes, occurred_at, source_recorded_at, enqueued_at
      ) VALUES (
        'session_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_generation, NEW.turn_attempt_id, NEW.sequence,
        NEW.client_event_id, NEW.turn_association, NEW.duplicate_of_event_id,
        NEW.duplicate_reason,
        NEW.type, 'session_event:' || NEW.id::text, v_initiator,
        coalesce(v_context, '{}'::jsonb), v_origin, NEW.payload,
        greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.created_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_host_usage_event_export()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_initiator jsonb := CASE
        WHEN NEW.initiator_kind IS NOT NULL THEN jsonb_strip_nulls(jsonb_build_object(
          'kind', NEW.initiator_kind,
          'subjectId', NEW.initiator_subject_id,
          'label', CASE
            WHEN jsonb_typeof(NEW.initiator_context -> 'label') = 'string'
            THEN left(NEW.initiator_context ->> 'label', 256)
            ELSE NULL
          END
        ))
        ELSE NULL
      END;
      v_context jsonb := jsonb_strip_nulls(jsonb_build_object(
        'label', CASE
          WHEN jsonb_typeof(NEW.initiator_context -> 'label') = 'string'
          THEN left(NEW.initiator_context ->> 'label', 256)
          ELSE NULL
        END,
        'backfill', CASE
          WHEN jsonb_typeof(NEW.initiator_context -> 'backfill') = 'boolean'
          THEN NEW.initiator_context -> 'backfill'
          ELSE NULL
        END
      ));
      v_origin text := NEW.origin;
      v_payload jsonb;
      v_payload_bytes integer;
    BEGIN
      SELECT c.usage_events_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1
      FOR SHARE;
      IF coalesce(v_enabled, false) = false THEN
        RETURN NEW;
      END IF;

      -- Export-specific bounds apply only while the optional host stream is
      -- enabled. Standalone/custom usage writers retain their historical
      -- behavior; an embedded writer that cannot be represented fails its
      -- source transaction visibly instead of committing a poison outbox row.
      IF octet_length(NEW.event_type) NOT BETWEEN 1 AND 256
        OR octet_length(NEW.unit) NOT BETWEEN 1 AND 128
        OR (NEW.subject_id IS NOT NULL AND octet_length(NEW.subject_id) > 1024)
        OR (NEW.source_resource_type IS NOT NULL
          AND octet_length(NEW.source_resource_type) > 256)
        OR (NEW.source_resource_id IS NOT NULL
          AND octet_length(NEW.source_resource_id) > 2048)
        OR octet_length(NEW.idempotency_key) NOT BETWEEN 1 AND 2048
        OR (NEW.billing_provider_event_id IS NOT NULL
          AND octet_length(NEW.billing_provider_event_id) > 2048) THEN
        RAISE EXCEPTION 'usage event exceeds the enabled host-export wire bounds'
          USING ERRCODE = '22001';
      END IF;

      IF NEW.turn_id IS NOT NULL THEN
        SELECT
          CASE WHEN octet_length(t.initiator_subject_id) <= 1024 THEN
            jsonb_strip_nulls(jsonb_build_object(
              'kind', t.initiator_kind,
              'subjectId', t.initiator_subject_id,
              'label', CASE
                WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
                THEN left(t.initiator_context ->> 'label', 256)
                ELSE NULL
              END
            ))
          ELSE NULL END,
          jsonb_strip_nulls(jsonb_build_object(
            'label', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'label') = 'string'
              THEN left(t.initiator_context ->> 'label', 256)
              ELSE NULL
            END,
            'backfill', CASE
              WHEN jsonb_typeof(t.initiator_context -> 'backfill') = 'boolean'
              THEN t.initiator_context -> 'backfill'
              ELSE NULL
            END,
            'attributionOmitted', CASE
              WHEN octet_length(t.initiator_subject_id) > 1024 THEN 'subject_id_too_large'
              ELSE NULL
            END
          )),
          t.source
        INTO v_initiator, v_context, v_origin
        FROM %1$I.session_turns t
        WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.turn_id;
      ELSIF v_initiator IS NULL AND NEW.subject_id IS NOT NULL
        AND octet_length(NEW.subject_id) <= 1024 THEN
        v_initiator := jsonb_build_object('kind', 'subject', 'subjectId', NEW.subject_id);
      END IF;

      v_payload := jsonb_build_object(
        'id', NEW.id,
        'workspaceId', NEW.workspace_id,
        'accountId', NEW.account_id,
        'subjectId', NEW.subject_id,
        'eventType', NEW.event_type,
        'quantity', NEW.quantity,
        'unit', NEW.unit,
        'sourceResourceType', NEW.source_resource_type,
        'sourceResourceId', NEW.source_resource_id,
        'idempotencyKey', NEW.idempotency_key,
        'occurredAt', NEW.occurred_at,
        'recordedAt', NEW.recorded_at,
        'exportedToBillingAt', NEW.exported_to_billing_at,
        'billingProviderEventId', NEW.billing_provider_event_id
      );
      v_payload_bytes := octet_length(v_payload::text)
        + octet_length(coalesce(v_initiator, 'null'::jsonb)::text)
        + octet_length(v_context::text)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_attempt_id, event_type, idempotency_key, initiator,
        initiator_context, origin, payload, envelope_bytes, occurred_at,
        source_recorded_at, enqueued_at
      ) VALUES (
        'usage_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_attempt_id, NEW.event_type, NEW.idempotency_key,
        v_initiator, coalesce(v_context, '{}'::jsonb), v_origin, v_payload,
        greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.recorded_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);
END $migration$;

DROP TRIGGER IF EXISTS session_events_host_export ON "session_events";
CREATE CONSTRAINT TRIGGER session_events_host_export
AFTER INSERT ON "session_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_host_session_event_export();

DROP TRIGGER IF EXISTS usage_events_host_export ON "usage_events";
CREATE CONSTRAINT TRIGGER usage_events_host_export
AFTER INSERT ON "usage_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enqueue_host_usage_event_export();

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.register_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_checkpoint bigint;
    BEGIN
      IF p_export_kind NOT IN ('session_event', 'usage_event') THEN
        RAISE EXCEPTION 'invalid host export kind' USING ERRCODE = '22023';
      END IF;
      IF p_consumer_id IS NULL OR length(p_consumer_id) NOT BETWEEN 1 AND 128
        OR p_consumer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
        RAISE EXCEPTION 'invalid host export consumer id' USING ERRCODE = '22023';
      END IF;

      SELECT s.pruned_through INTO v_checkpoint
      FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      INSERT INTO %1$I.host_export_consumers (consumer_id, export_kind, checkpoint)
      VALUES (p_consumer_id, p_export_kind, v_checkpoint)
      ON CONFLICT (export_kind, consumer_id) DO UPDATE
      SET enabled = true, updated_at = now();

      UPDATE %1$I.host_export_config
      SET session_events_enabled = CASE WHEN p_export_kind = 'session_event' THEN true ELSE session_events_enabled END,
          usage_events_enabled = CASE WHEN p_export_kind = 'usage_event' THEN true ELSE usage_events_enabled END,
          updated_at = now()
      WHERE id = 1;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.allocate_host_export_cursors(
      p_export_kind text, p_limit integer
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_id uuid;
      v_next bigint;
      v_count integer := 0;
      v_limit integer := greatest(1, least(coalesce(p_limit, 512), 4096));
    BEGIN
      SELECT s.next_cursor INTO v_next
      FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF v_next IS NULL THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      WHILE v_count < v_limit LOOP
        SELECT o.id INTO v_id
        FROM %1$I.host_export_outbox o
        WHERE o.export_kind = p_export_kind
          AND o.export_cursor IS NULL
          AND (
            o.session_id IS NULL OR o.session_sequence IS NULL OR NOT EXISTS (
              SELECT 1 FROM %1$I.host_export_outbox earlier
              WHERE earlier.export_kind = o.export_kind
                AND earlier.session_id = o.session_id
                AND earlier.session_sequence IS NOT NULL
                AND earlier.session_sequence < o.session_sequence
                AND earlier.export_cursor IS NULL
            )
          )
        ORDER BY o.enqueued_at, o.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1;
        EXIT WHEN v_id IS NULL;

        UPDATE %1$I.host_export_outbox
        SET export_cursor = v_next
        WHERE id = v_id AND export_cursor IS NULL;
        v_next := v_next + 1;
        v_count := v_count + 1;
        v_id := NULL;
      END LOOP;

      UPDATE %1$I.host_export_cursor_state
      SET next_cursor = v_next, updated_at = now()
      WHERE export_kind = p_export_kind;
      RETURN v_count;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.claim_host_export_batch(
      p_export_kind text,
      p_consumer_id text,
      p_lease_token uuid,
      p_lease_holder_id text,
      p_lease_seconds integer,
      p_limit integer,
      p_max_bytes integer
    ) RETURNS TABLE (
      consumer_id text, export_kind text, checkpoint bigint,
      lease_token uuid, lease_through bigint, export_cursor bigint,
      source_id uuid, account_id uuid, workspace_id uuid, session_id uuid,
      turn_id uuid, turn_generation integer, turn_attempt_id uuid,
      session_sequence integer, client_event_id text, turn_association text,
      duplicate_of_event_id uuid, duplicate_reason text,
      event_type text, idempotency_key text,
      initiator jsonb, initiator_context jsonb, origin text, payload jsonb,
      occurred_at timestamptz, source_recorded_at timestamptz
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
      v_through bigint;
      v_limit integer := greatest(1, least(coalesce(p_limit, 100), 256));
      v_max_bytes integer := greatest(98304, least(coalesce(p_max_bytes, 1048576), 4194304));
      v_lease_seconds integer := greatest(5, least(coalesce(p_lease_seconds, 60), 300));
    BEGIN
      IF p_lease_token IS NULL THEN
        RAISE EXCEPTION 'host export lease token is required' USING ERRCODE = '22023';
      END IF;
      IF p_lease_holder_id IS NULL OR length(p_lease_holder_id) NOT BETWEEN 1 AND 128 THEN
        RAISE EXCEPTION 'host export lease holder id is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM opengeni_host_export.allocate_host_export_cursors(
        p_export_kind, greatest(v_limit, 512)
      );

      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND OR NOT v_consumer.enabled OR v_consumer.blocked_at IS NOT NULL
        OR v_consumer.next_attempt_at > now()
        OR (v_consumer.lease_expires_at IS NOT NULL AND v_consumer.lease_expires_at > now()) THEN
        RETURN;
      END IF;

      WITH candidates AS MATERIALIZED (
        SELECT o.export_cursor, o.envelope_bytes
        FROM %1$I.host_export_outbox o
        WHERE o.export_kind = p_export_kind
          AND o.export_cursor > v_consumer.checkpoint
        ORDER BY o.export_cursor
        LIMIT v_limit
      ), ranked AS (
        SELECT o.export_cursor,
          row_number() OVER (ORDER BY o.export_cursor) AS row_number,
          sum(o.envelope_bytes) OVER (ORDER BY o.export_cursor) AS running_bytes
        FROM candidates o
      ), selected AS (
        SELECT r.export_cursor FROM ranked r
        WHERE r.running_bytes <= v_max_bytes OR r.row_number = 1
      )
      SELECT max(s.export_cursor) INTO v_through FROM selected s;
      IF v_through IS NULL THEN
        RETURN;
      END IF;

      UPDATE %1$I.host_export_consumers c
      SET lease_token = p_lease_token,
          lease_holder_id = left(p_lease_holder_id, 128),
          lease_expires_at = now() + make_interval(secs => v_lease_seconds),
          lease_from = v_consumer.checkpoint,
          lease_through = v_through,
          updated_at = now()
      WHERE c.id = v_consumer.id;

      RETURN QUERY
      SELECT p_consumer_id, p_export_kind, v_consumer.checkpoint,
        p_lease_token, v_through, o.export_cursor, o.source_id,
        o.account_id, o.workspace_id, o.session_id, o.turn_id,
        o.turn_generation, o.turn_attempt_id, o.session_sequence,
        o.client_event_id, o.turn_association, o.duplicate_of_event_id,
        o.duplicate_reason,
        o.event_type, o.idempotency_key, o.initiator,
        o.initiator_context, o.origin, o.payload, o.occurred_at,
        o.source_recorded_at
      FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind
        AND o.export_cursor > v_consumer.checkpoint
        AND o.export_cursor <= v_through
      ORDER BY o.export_cursor;
    END $function$;
  $create$, target_schema);
END $migration$;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.ack_host_export_batch(
      p_export_kind text, p_consumer_id text, p_lease_token uuid
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_checkpoint bigint;
    BEGIN
      UPDATE %1$I.host_export_consumers c
      SET checkpoint = c.lease_through,
          lease_token = NULL, lease_holder_id = NULL, lease_expires_at = NULL,
          lease_from = NULL, lease_through = NULL,
          consecutive_failures = 0, next_attempt_at = now(),
          last_error = NULL, last_error_at = NULL, updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
        AND c.lease_token = p_lease_token AND c.lease_through IS NOT NULL
      RETURNING c.checkpoint INTO v_checkpoint;
      IF v_checkpoint IS NULL THEN
        RAISE EXCEPTION 'host export lease is stale' USING ERRCODE = '40001';
      END IF;
      RETURN v_checkpoint;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.fail_host_export_batch(
      p_export_kind text, p_consumer_id text, p_lease_token uuid,
      p_error text, p_max_failures integer
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_failures integer;
    BEGIN
      UPDATE %1$I.host_export_consumers c
      SET consecutive_failures = c.consecutive_failures + 1,
          lease_token = NULL, lease_holder_id = NULL, lease_expires_at = NULL,
          lease_from = NULL, lease_through = NULL,
          next_attempt_at = now() + make_interval(
            secs => least(300, greatest(1, power(2, least(c.consecutive_failures, 8))::integer))
          ),
          last_error = left(coalesce(p_error, 'host sink failed'), 500),
          last_error_at = now(),
          blocked_at = CASE
            WHEN c.consecutive_failures + 1 >= greatest(1, least(coalesce(p_max_failures, 20), 1000))
            THEN now() ELSE NULL END,
          updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
        AND c.lease_token = p_lease_token
      RETURNING c.consecutive_failures INTO v_failures;
      IF v_failures IS NULL THEN
        RAISE EXCEPTION 'host export lease is stale' USING ERRCODE = '40001';
      END IF;
      RETURN v_failures;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.resume_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      UPDATE %1$I.host_export_consumers c
      SET blocked_at = NULL, consecutive_failures = 0, next_attempt_at = now(),
          lease_token = NULL, lease_holder_id = NULL, lease_expires_at = NULL,
          lease_from = NULL, lease_through = NULL, updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002'; END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.rewind_host_export_consumer(
      p_export_kind text, p_consumer_id text, p_checkpoint bigint
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_pruned_through bigint; v_max bigint;
    BEGIN
      IF p_checkpoint < 0 THEN RAISE EXCEPTION 'checkpoint must be nonnegative' USING ERRCODE = '22023'; END IF;
      SELECT s.pruned_through, s.next_cursor - 1
      INTO v_pruned_through, v_max
      FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;
      IF p_checkpoint < v_pruned_through THEN
        RAISE EXCEPTION 'requested host export cursor is no longer retained' USING ERRCODE = '22023';
      END IF;
      IF p_checkpoint > v_max THEN
        RAISE EXCEPTION 'requested host export cursor has not been allocated' USING ERRCODE = '22023';
      END IF;
      UPDATE %1$I.host_export_consumers c
      SET checkpoint = p_checkpoint, blocked_at = NULL, consecutive_failures = 0,
          next_attempt_at = now(), lease_token = NULL, lease_holder_id = NULL,
          lease_expires_at = NULL, lease_from = NULL, lease_through = NULL,
          updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002'; END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.prune_host_export_outbox(
      p_export_kind text, p_grace_seconds integer, p_limit integer
    ) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_checkpoint bigint; v_deleted integer; v_pruned_through bigint;
    BEGIN
      PERFORM 1 FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;
      SELECT min(c.checkpoint) INTO v_checkpoint FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind;
      IF v_checkpoint IS NULL OR v_checkpoint = 0 THEN RETURN 0; END IF;
      WITH doomed AS (
        SELECT o.id FROM %1$I.host_export_outbox o
        WHERE o.export_kind = p_export_kind
          AND o.export_cursor <= v_checkpoint
          AND o.enqueued_at < now() - make_interval(
            secs => greatest(0, least(coalesce(p_grace_seconds, 3600), 604800))
          )
        ORDER BY o.export_cursor
        LIMIT greatest(1, least(coalesce(p_limit, 1000), 10000))
        FOR UPDATE SKIP LOCKED
      ), deleted AS (
        DELETE FROM %1$I.host_export_outbox o
        USING doomed d WHERE o.id = d.id
        RETURNING o.export_cursor
      )
      SELECT count(*)::integer, max(d.export_cursor)
      INTO v_deleted, v_pruned_through
      FROM deleted d;
      IF v_pruned_through IS NOT NULL THEN
        UPDATE %1$I.host_export_cursor_state s
        SET pruned_through = greatest(s.pruned_through, v_pruned_through),
            updated_at = now()
        WHERE s.export_kind = p_export_kind;
      END IF;
      RETURN v_deleted;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.disable_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      PERFORM 1 FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      UPDATE %1$I.host_export_consumers c
      SET enabled = false, updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM %1$I.host_export_consumers c
        WHERE c.export_kind = p_export_kind AND c.enabled
      ) THEN
        UPDATE %1$I.host_export_config
        SET session_events_enabled = CASE
              WHEN p_export_kind = 'session_event' THEN false
              ELSE session_events_enabled
            END,
            usage_events_enabled = CASE
              WHEN p_export_kind = 'usage_event' THEN false
              ELSE usage_events_enabled
            END,
            updated_at = now()
        WHERE id = 1;
      END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.retire_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      PERFORM 1 FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      DELETE FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM %1$I.host_export_consumers c
        WHERE c.export_kind = p_export_kind AND c.enabled
      ) THEN
        UPDATE %1$I.host_export_config
        SET session_events_enabled = CASE
              WHEN p_export_kind = 'session_event' THEN false
              ELSE session_events_enabled
            END,
            usage_events_enabled = CASE
              WHEN p_export_kind = 'usage_event' THEN false
              ELSE usage_events_enabled
            END,
            updated_at = now()
        WHERE id = 1;
      END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.dead_letter_host_export_head(
      p_export_kind text, p_consumer_id text, p_lease_token uuid,
      p_export_cursor bigint, p_reason text
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
      v_row %1$I.host_export_outbox%%ROWTYPE;
      v_envelope jsonb;
    BEGIN
      IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'dead-letter reason must contain 1 to 500 characters'
          USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND OR v_consumer.lease_token IS DISTINCT FROM p_lease_token
        OR v_consumer.lease_through IS NULL THEN
        RAISE EXCEPTION 'host export lease is stale' USING ERRCODE = '40001';
      END IF;
      IF p_export_cursor IS NULL OR p_export_cursor <> v_consumer.checkpoint + 1
        OR p_export_cursor > v_consumer.lease_through THEN
        RAISE EXCEPTION 'only the leased head event may be dead-lettered'
          USING ERRCODE = '22023';
      END IF;

      SELECT * INTO STRICT v_row FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind AND o.export_cursor = p_export_cursor;
      IF p_export_kind = 'session_event' THEN
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'idempotencyKey', v_row.idempotency_key,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'event', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row.source_id,
            'workspaceId', v_row.workspace_id,
            'sessionId', v_row.session_id,
            'sequence', v_row.session_sequence,
            'type', v_row.event_type,
            'payload', v_row.payload,
            'occurredAt', v_row.occurred_at,
            'clientEventId', v_row.client_event_id,
            'turnId', v_row.turn_id,
            'turnGeneration', v_row.turn_generation,
            'turnAttemptId', v_row.turn_attempt_id,
            'turnAssociation', v_row.turn_association,
            'duplicateOfEventId', v_row.duplicate_of_event_id,
            'duplicateReason', v_row.duplicate_reason
          ))
        );
      ELSE
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'sessionId', v_row.session_id,
          'turnId', v_row.turn_id,
          'turnAttemptId', v_row.turn_attempt_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'usage', v_row.payload
        );
      END IF;

      INSERT INTO %1$I.host_export_dead_letters (
        consumer_id, export_kind, export_cursor, source_id, reason, envelope
      ) VALUES (
        p_consumer_id, p_export_kind, p_export_cursor, v_row.source_id,
        p_reason, v_envelope
      ) ON CONFLICT (export_kind, consumer_id, export_cursor) DO NOTHING;

      UPDATE %1$I.host_export_consumers c
      SET checkpoint = p_export_cursor,
          lease_token = NULL, lease_holder_id = NULL, lease_expires_at = NULL,
          lease_from = NULL, lease_through = NULL,
          consecutive_failures = 0, next_attempt_at = now(),
          last_error = left('dead-lettered: ' || p_reason, 500),
          last_error_at = now(), blocked_at = NULL, updated_at = now()
      WHERE c.id = v_consumer.id;
      RETURN p_export_cursor;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.host_export_consumer_status(
      p_export_kind text, p_consumer_id text
    ) RETURNS TABLE (
      export_kind text, consumer_id text, checkpoint bigint, enabled boolean,
      consecutive_failures integer, next_attempt_at timestamptz,
      last_error text, last_error_at timestamptz, blocked_at timestamptz,
      lease_expires_at timestamptz, max_cursor bigint, pending_count bigint,
      unassigned_count bigint, pruned_through bigint
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      SELECT c.export_kind, c.consumer_id, c.checkpoint, c.enabled,
        c.consecutive_failures, c.next_attempt_at, c.last_error,
        c.last_error_at, c.blocked_at, c.lease_expires_at,
        greatest(s.next_cursor - 1, c.checkpoint),
        (
          SELECT count(*) FROM %1$I.host_export_outbox assigned
          WHERE assigned.export_kind = c.export_kind
            AND assigned.export_cursor > c.checkpoint
        ) + (
          SELECT count(*) FROM %1$I.host_export_outbox unassigned
          WHERE unassigned.export_kind = c.export_kind
            AND unassigned.export_cursor IS NULL
        ),
        (
          SELECT count(*) FROM %1$I.host_export_outbox unassigned
          WHERE unassigned.export_kind = c.export_kind
            AND unassigned.export_cursor IS NULL
        ),
        s.pruned_through
      FROM %1$I.host_export_consumers c
      JOIN %1$I.host_export_cursor_state s ON s.export_kind = c.export_kind
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
    $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_host_session_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_host_usage_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.validate_usage_event_execution_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.host_export_session_root(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.capture_host_export_root_session() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.register_host_export_consumer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.allocate_host_export_cursors(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.claim_host_export_batch(text, text, uuid, text, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.ack_host_export_batch(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.fail_host_export_batch(text, text, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.resume_host_export_consumer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.rewind_host_export_consumer(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.prune_host_export_outbox(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.disable_host_export_consumer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.retire_host_export_consumer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.dead_letter_host_export_head(text, text, uuid, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.host_export_consumer_status(text, text) FROM PUBLIC;

-- Intentionally no app-role grant. Cross-workspace host projection is an
-- operator capability provisioned onto a distinct optional exporter role.
