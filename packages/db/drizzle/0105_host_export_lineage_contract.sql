-- deployment-mode: rolling
-- Forward-only repair for published 0097/0103/0104 histories. Immutable root
-- capture already exists after 0103; this migration linearizes first-consumer
-- enablement with deferred producers and validates the session/root invariant.
-- It never derives or rewrites historical lineage. Rows that may have been
-- populated by the old 0104 backfill require explicit evidence-backed
-- disposition before retry.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Replacing these SECURITY DEFINER functions preserves their identity, owner,
-- and existing exporter ACL while making the config-row lock the commit-order
-- boundary between first-consumer registration and deferred source capture.
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

REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_session_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_usage_event_export() FROM PUBLIC;

-- The old 0104 backfill resolved lineage from then-current session ancestry.
-- A session-scoped row enqueued before 0103's durable ledger boundary therefore
-- lacks immutable-capture provenance even when its root is non-null. Reject the
-- candidate without touching data. The single-row probe is bounded by the
-- migration statement timeout; operators must disposition suspect history
-- separately and rerun the same migration.
DO $migration$
DECLARE
  capture_applied_at timestamptz;
  capture_ledger_rows integer;
  suspect_source_id uuid;
BEGIN
  SELECT min(m.applied_at), count(*)::integer
  INTO capture_applied_at, capture_ledger_rows
  FROM "schema_migrations" m
  WHERE m.name = '0103_host_export_root_session.sql';

  IF capture_ledger_rows <> 1 OR capture_applied_at IS NULL THEN
    RAISE EXCEPTION '0105 requires the exact 0103 schema-migration ledger boundary'
      USING ERRCODE = '55000',
        HINT = 'Apply migrations through immutable 0104 with the canonical runner before retrying 0105.';
  END IF;

  SELECT o.source_id
  INTO suspect_source_id
  FROM "host_export_outbox" o
  WHERE o.session_id IS NOT NULL
    AND (
      o.root_session_id IS NULL
      OR o.enqueued_at < capture_applied_at
    )
  ORDER BY o.enqueued_at, o.source_id
  LIMIT 1;

  IF suspect_source_id IS NOT NULL THEN
    RAISE EXCEPTION '0105 found host-export lineage without immutable-capture provenance'
      USING ERRCODE = '23514',
        HINT = 'Do not derive lineage from current sessions; use an evidence-backed maintenance disposition, then retry 0105.';
  END IF;
END $migration$;

DO $migration$
DECLARE
  existing_expression text;
  normalized_expression text;
BEGIN
  SELECT pg_get_expr(c.conbin, c.conrelid, true)
  INTO existing_expression
  FROM pg_catalog.pg_constraint c
  WHERE c.conname = 'host_export_outbox_root_session_check'
    AND c.conrelid = 'host_export_outbox'::regclass
    AND c.contype = 'c'
    AND NOT c.connoinherit;

  IF existing_expression IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint c
      WHERE c.conname = 'host_export_outbox_root_session_check'
        AND c.conrelid = 'host_export_outbox'::regclass
    ) THEN
      RAISE EXCEPTION 'host_export_outbox_root_session_check has an incompatible constraint type'
        USING ERRCODE = '55000';
    END IF;

    ALTER TABLE "host_export_outbox"
      ADD CONSTRAINT "host_export_outbox_root_session_check"
      CHECK ("session_id" IS NULL OR "root_session_id" IS NOT NULL)
      NOT VALID;
  ELSE
    normalized_expression := lower(regexp_replace(
      existing_expression,
      '["()[:space:]]',
      '',
      'g'
    ));
    IF normalized_expression <> 'session_idisnullorroot_session_idisnotnull' THEN
      RAISE EXCEPTION 'host_export_outbox_root_session_check has an incompatible expression'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END $migration$;

-- VALIDATE takes SHARE UPDATE EXCLUSIVE, which permits ordinary reads/writes.
-- Both lock acquisition and the read-only table scan are source-bounded above;
-- timeout is a retryable operator disposition, never permission to rewrite data.
DO $migration$
BEGIN
  ALTER TABLE "host_export_outbox"
    VALIDATE CONSTRAINT "host_export_outbox_root_session_check";
EXCEPTION
  WHEN check_violation THEN
    RAISE EXCEPTION '0105 cannot validate host-export lineage without historical provenance'
      USING ERRCODE = '23514',
        HINT = 'Do not derive lineage from current sessions; use an evidence-backed maintenance disposition, then retry 0105.';
END $migration$;
