-- deployment-mode: rolling
-- Budget-reservation holds and releases are ordinary usage_events rows under
-- `<eventType>.reserved` event types. They are internal admission accounting —
-- never customer-billable usage — so the optional host export stream must not
-- ship them. The `.reserved` suffix is the contract: every internal hold or
-- release event type carries it, and exclusion happens inside the enqueue
-- trigger so a later `.reserved` type is covered automatically. Committed
-- usage facts (model.cost, model.tokens, agent_run.*) are unchanged.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
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
      -- Internal budget-reservation rows never leave the deployment.
      IF NEW.event_type LIKE '%%.reserved' THEN
        RETURN NEW;
      END IF;

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
