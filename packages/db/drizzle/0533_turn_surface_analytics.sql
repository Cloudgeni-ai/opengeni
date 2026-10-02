-- deployment-mode: rolling
-- Content-free product-analytics dimensions on accepted turns and the optional
-- host export.
--
-- session_turns.surface records the product surface a turn's request entered
-- through (web, Slack, an API key, an embedding host, a scheduled task, an
-- agent, voice, a Site, an automation, an external MCP client, or OpenGeni's
-- own maintenance). It is a fixed-list analytics label, never an
-- authorization input, and is immutable after admission like prompt_routing.
-- Null is legacy/rolling compatibility: a pre-0532 writer inserts no value.
--
-- The host export gains three columns next to origin: the attributed turn's
-- surface, the model provider family from the turn's accepted execution
-- policy (reserved OpenGeni provider ids, or `registry` for every
-- operator-configured provider), and the tool family an
-- `agent.toolCall.created` event carries in its payload. Each is checked
-- against its fixed format again here, so a malformed value exports as NULL
-- instead of blocking the source transaction.
--
-- The published claim_host_export_batch and host_export_claim_sidecars
-- signatures stay unchanged. Consumers read the new columns through the
-- companion host_export_claim_analytics_sidecars helper under the same lease,
-- which inherits the claim function's exporter ACL. Existing immutable export
-- rows and consumer checkpoints are untouched; rows enqueued before this
-- migration keep NULL in the new columns.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE session_turns
  ADD COLUMN IF NOT EXISTS surface text;

ALTER TABLE session_turns
  ADD CONSTRAINT session_turns_surface_check CHECK (
    surface IS NULL OR surface IN (
      'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
      'voice', 'site', 'automation', 'mcp', 'system'
    )
  ) NOT VALID;

ALTER TABLE session_turns
  VALIDATE CONSTRAINT session_turns_surface_check;

CREATE FUNCTION opengeni_private.reject_session_turn_surface_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.surface IS DISTINCT FROM OLD.surface THEN
    RAISE EXCEPTION 'turn surface is immutable after admission'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.reject_session_turn_surface_mutation() FROM PUBLIC;

CREATE TRIGGER session_turns_surface_immutable
  BEFORE UPDATE OF surface ON session_turns
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reject_session_turn_surface_mutation();

COMMENT ON COLUMN session_turns.surface IS
  'Immutable product surface the turn request entered through. Analytics only, never authority. Null is rolling/legacy compatibility.';

ALTER TABLE host_export_outbox
  ADD COLUMN IF NOT EXISTS surface text,
  ADD COLUMN IF NOT EXISTS model_provider text,
  ADD COLUMN IF NOT EXISTS tool_family text;

ALTER TABLE host_export_outbox
  ADD CONSTRAINT host_export_outbox_analytics_check CHECK (
    (surface IS NULL OR surface IN (
      'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
      'voice', 'site', 'automation', 'mcp', 'system'
    ))
    AND (model_provider IS NULL OR model_provider IN (
      'openai', 'azure', 'codex-subscription', 'supergrok-subscription',
      'opengeni-gateway', 'workspace-gateway', 'organization-gateway',
      'openrouter', 'workspace-openrouter', 'organization-openrouter', 'registry'
    ))
    AND (tool_family IS NULL OR tool_family ~
      '^(custom|integration:[a-z0-9]([a-z0-9.-]{0,150}[a-z0-9])?|[a-z][a-z0-9_]{0,63})$')
  ) NOT VALID;

ALTER TABLE host_export_outbox
  VALIDATE CONSTRAINT host_export_outbox_analytics_check;

-- Mirrors analyticsModelProvider in packages/contracts/src/product-analytics.ts.
CREATE OR REPLACE FUNCTION opengeni_private.analytics_model_provider(p_provider_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_provider_id IN (
      'openai', 'azure', 'codex-subscription', 'supergrok-subscription',
      'opengeni-gateway', 'workspace-gateway', 'organization-gateway',
      'openrouter', 'workspace-openrouter', 'organization-openrouter'
    ) THEN p_provider_id
    WHEN p_provider_id ~ '^[A-Za-z0-9_-]{1,128}$' THEN 'registry'
    ELSE NULL
  END
$function$;

REVOKE ALL ON FUNCTION opengeni_private.analytics_model_provider(text) FROM PUBLIC;

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
      v_surface text;
      v_model_provider text;
      v_tool_family text;
      v_attribution_turn_id uuid;
      v_source_payload_bytes integer;
      v_export_payload jsonb;
      v_export_payload_codec_version smallint;
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

      v_attribution_turn_id := NEW.turn_id;
      IF v_attribution_turn_id IS NULL AND NEW.type = 'user.message' THEN
        SELECT min(t.id::text)::uuid INTO v_attribution_turn_id
        FROM %1$I.session_turns t
        WHERE t.account_id = NEW.account_id
          AND t.workspace_id = NEW.workspace_id
          AND t.session_id = NEW.session_id
          AND t.trigger_event_id = NEW.id
        HAVING count(*) = 1;
      END IF;

      IF v_attribution_turn_id IS NOT NULL THEN
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
          t.source,
          t.surface,
          opengeni_private.analytics_model_provider(
            CASE
              WHEN jsonb_typeof(t.metadata #> '{turnExecutionPolicyV1,providerId}') = 'string'
              THEN t.metadata #>> '{turnExecutionPolicyV1,providerId}'
              ELSE NULL
            END
          )
        INTO v_initiator, v_context, v_origin, v_surface, v_model_provider
        FROM %1$I.session_turns t
        WHERE t.account_id = NEW.account_id
          AND t.workspace_id = NEW.workspace_id
          AND t.session_id = NEW.session_id
          AND t.id = v_attribution_turn_id;
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

      -- The worker stamps a content-free family on the tool-call event. Check
      -- the fixed wire format again so a malformed value exports as NULL.
      IF NEW.type = 'agent.toolCall.created'
        AND jsonb_typeof(NEW.payload -> 'toolFamily') = 'string' THEN
        v_tool_family := NEW.payload ->> 'toolFamily';
        IF v_tool_family !~
          '^(custom|integration:[a-z0-9]([a-z0-9.-]{0,150}[a-z0-9])?|[a-z][a-z0-9_]{0,63})$' THEN
          v_tool_family := NULL;
        END IF;
      END IF;
      IF v_surface IS NOT NULL AND v_surface NOT IN (
        'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
        'voice', 'site', 'automation', 'mcp', 'system'
      ) THEN
        v_surface := NULL;
      END IF;

      v_source_payload_bytes := octet_length(NEW.payload::text);
      v_export_payload := NEW.payload;
      v_export_payload_codec_version := NEW.payload_codec_version;
      IF v_source_payload_bytes > 65536 THEN
        v_export_payload := jsonb_build_object(
          '_hostExport', jsonb_build_object(
            'payloadMode', 'summary',
            'payloadTruncated', true,
            'originalBytes', v_source_payload_bytes,
            'sourceEventId', NEW.id,
            'fullPayload', 'retained in canonical session event'
          ),
          'preview', '[host-export payload omitted at bounded projection boundary]'
        );
        -- The projection is literal PostgreSQL JSON, not an application-codec
        -- envelope. Preserve codec truth only when the original payload is kept.
        v_export_payload_codec_version := NULL;
      END IF;

      v_payload_bytes := octet_length(v_export_payload::text)
        + octet_length(NEW.type)
        + coalesce(octet_length(NEW.client_event_id), 0)
        + coalesce(octet_length(NEW.turn_association), 0)
        + coalesce(octet_length(NEW.duplicate_reason), 0)
        + octet_length(coalesce(v_initiator, 'null'::jsonb)::text)
        + octet_length(v_context::text)
        + coalesce(octet_length(v_surface), 0)
        + coalesce(octet_length(v_model_provider), 0)
        + coalesce(octet_length(v_tool_family), 0)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_generation, turn_attempt_id, session_sequence,
        client_event_id, turn_association, duplicate_of_event_id, duplicate_reason,
        event_type, idempotency_key, initiator, initiator_context, origin,
        surface, model_provider, tool_family,
        payload, payload_codec_version, envelope_bytes, occurred_at,
        source_recorded_at, enqueued_at
      ) VALUES (
        'session_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_generation, NEW.turn_attempt_id, NEW.sequence,
        NEW.client_event_id, NEW.turn_association, NEW.duplicate_of_event_id,
        NEW.duplicate_reason,
        NEW.type, 'session_event:' || NEW.id::text, v_initiator,
        coalesce(v_context, '{}'::jsonb), v_origin,
        v_surface, v_model_provider, v_tool_family,
        v_export_payload,
        v_export_payload_codec_version, greatest(1, v_payload_bytes), NEW.occurred_at,
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
      v_surface text;
      v_model_provider text;
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
          t.source,
          t.surface,
          opengeni_private.analytics_model_provider(
            CASE
              WHEN jsonb_typeof(t.metadata #> '{turnExecutionPolicyV1,providerId}') = 'string'
              THEN t.metadata #>> '{turnExecutionPolicyV1,providerId}'
              ELSE NULL
            END
          )
        INTO v_initiator, v_context, v_origin, v_surface, v_model_provider
        FROM %1$I.session_turns t
        WHERE t.workspace_id = NEW.workspace_id AND t.id = NEW.turn_id;
      ELSIF v_initiator IS NULL AND NEW.subject_id IS NOT NULL
        AND octet_length(NEW.subject_id) <= 1024 THEN
        v_initiator := jsonb_build_object('kind', 'subject', 'subjectId', NEW.subject_id);
      END IF;
      IF v_surface IS NOT NULL AND v_surface NOT IN (
        'web', 'slack', 'api_key', 'embedded', 'scheduled', 'agent',
        'voice', 'site', 'automation', 'mcp', 'system'
      ) THEN
        v_surface := NULL;
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
        + coalesce(octet_length(v_surface), 0)
        + coalesce(octet_length(v_model_provider), 0)
        + 768;
      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, session_id,
        turn_id, turn_attempt_id, event_type, idempotency_key, initiator,
        initiator_context, origin, surface, model_provider, payload,
        envelope_bytes, occurred_at, source_recorded_at, enqueued_at
      ) VALUES (
        'usage_event', NEW.id, NEW.account_id, NEW.workspace_id, NEW.session_id,
        NEW.turn_id, NEW.turn_attempt_id, NEW.event_type, NEW.idempotency_key,
        v_initiator, coalesce(v_context, '{}'::jsonb), v_origin,
        v_surface, v_model_provider, v_payload,
        greatest(1, v_payload_bytes), NEW.occurred_at,
        NEW.recorded_at, clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      RETURN NEW;
    END $function$;
  $create$, target_schema);

  -- Companion to the published claim and root/codec sidecars: the new
  -- analytics columns for exactly the rows leased to this consumer. Callers
  -- read it in the same transaction as claim_host_export_batch.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.host_export_claim_analytics_sidecars(
      p_export_kind text,
      p_consumer_id text,
      p_lease_token uuid
    ) RETURNS TABLE (
      export_cursor bigint,
      surface text,
      model_provider text,
      tool_family text
    )
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
      SELECT o.export_cursor, o.surface, o.model_provider, o.tool_family
      FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind
        AND o.export_cursor > v_consumer.lease_from
        AND o.export_cursor <= v_consumer.lease_through
      ORDER BY o.export_cursor;
    END $function$;
  $create$, target_schema);
END
$migration$;

REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_session_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.enqueue_host_usage_event_export() FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_host_export.host_export_claim_analytics_sidecars(text, text, uuid) FROM PUBLIC;

-- Preserve existing host-configured exporter grants for the new companion
-- without guessing a role name. The published claim function remains the ACL
-- authority and is otherwise unchanged.
DO $migration$
DECLARE v_role name;
BEGIN
  FOR v_role IN
    SELECT grantee.rolname
    FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
    ) privilege
    JOIN pg_catalog.pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE proc.oid =
      'opengeni_host_export.claim_host_export_batch(text, text, uuid, text, integer, integer, integer)'::regprocedure
      AND privilege.grantee <> proc.proowner
      AND privilege.privilege_type = 'EXECUTE'
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_host_export.host_export_claim_analytics_sidecars(text, text, uuid) TO %I',
      v_role
    );
  END LOOP;
END $migration$;
