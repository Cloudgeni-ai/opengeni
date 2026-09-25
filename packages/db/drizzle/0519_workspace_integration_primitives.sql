-- deployment-mode: rolling
-- Generic workspace integration primitives for standalone embedding hosts:
--   * one optional HTTP credential provider per workspace, used as the
--     workspace's run-credential resolver;
--   * workspace webhooks with a per-endpoint signing secret;
--   * a durable per-endpoint delivery outbox, enqueued in the same
--     transaction as the terminal/attention session event that caused it.
-- Everything is additive. Older binaries never read these tables, and a
-- workspace without a provider or webhook behaves exactly as before.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "workspace_credential_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "url" text NOT NULL,
  "secret_encrypted" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "timeout_ms" integer NOT NULL DEFAULT 10000,
  "created_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_credential_providers_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_credential_providers_url_chk" CHECK (
    char_length("url") BETWEEN 8 AND 2048
    AND ("url" LIKE 'https://%' OR "url" LIKE 'http://%')
  ),
  CONSTRAINT "workspace_credential_providers_timeout_chk" CHECK (
    "timeout_ms" BETWEEN 1000 AND 30000
  ),
  CONSTRAINT "workspace_credential_providers_subject_chk" CHECK (
    "created_by_subject_id" IS NULL OR octet_length("created_by_subject_id") BETWEEN 1 AND 1024
  )
);
CREATE UNIQUE INDEX "workspace_credential_providers_workspace_uq"
  ON "workspace_credential_providers" ("workspace_id");

CREATE TABLE "workspace_webhooks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "url" text NOT NULL,
  "secret_encrypted" text NOT NULL,
  "event_types" text[] NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "description" text,
  "created_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_webhooks_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_webhooks_workspace_id_uq" UNIQUE ("workspace_id", "id"),
  CONSTRAINT "workspace_webhooks_url_chk" CHECK (
    char_length("url") BETWEEN 8 AND 2048
    AND ("url" LIKE 'https://%' OR "url" LIKE 'http://%')
  ),
  CONSTRAINT "workspace_webhooks_event_types_chk" CHECK (
    cardinality("event_types") BETWEEN 1 AND 16
    AND "event_types" <@ ARRAY[
      'turn.completed',
      'turn.failed',
      'turn.cancelled',
      'session.status.changed',
      'session.requiresAction',
      'session.humanInput.requested'
    ]::text[]
  ),
  CONSTRAINT "workspace_webhooks_description_chk" CHECK (
    "description" IS NULL OR char_length("description") <= 500
  ),
  CONSTRAINT "workspace_webhooks_subject_chk" CHECK (
    "created_by_subject_id" IS NULL OR octet_length("created_by_subject_id") BETWEEN 1 AND 1024
  )
);
CREATE INDEX "workspace_webhooks_workspace_idx"
  ON "workspace_webhooks" ("workspace_id", "created_at");

CREATE TABLE "workspace_webhook_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL,
  "webhook_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "delivered_at" timestamptz,
  "failed_at" timestamptz,
  "last_status" integer,
  "last_error" text,
  "claim_id" uuid,
  "claim_until" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_webhook_deliveries_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "workspace_webhook_deliveries_webhook_fk"
    FOREIGN KEY ("workspace_id", "webhook_id")
    REFERENCES "workspace_webhooks"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "workspace_webhook_deliveries_attempts_chk" CHECK ("attempts" >= 0),
  CONSTRAINT "workspace_webhook_deliveries_claim_chk" CHECK (
    ("claim_id" IS NULL) = ("claim_until" IS NULL)
  ),
  CONSTRAINT "workspace_webhook_deliveries_terminal_chk" CHECK (
    "delivered_at" IS NULL OR "failed_at" IS NULL
  ),
  CONSTRAINT "workspace_webhook_deliveries_error_chk" CHECK (
    "last_error" IS NULL OR char_length("last_error") <= 2000
  ),
  CONSTRAINT "workspace_webhook_deliveries_payload_chk" CHECK (
    octet_length("payload"::text) <= 16384
  )
);
CREATE UNIQUE INDEX "workspace_webhook_deliveries_event_uq"
  ON "workspace_webhook_deliveries" ("webhook_id", "event_id");
CREATE INDEX "workspace_webhook_deliveries_due_idx"
  ON "workspace_webhook_deliveries" ("next_attempt_at", "id")
  WHERE "delivered_at" IS NULL AND "failed_at" IS NULL;
CREATE INDEX "workspace_webhook_deliveries_webhook_recent_idx"
  ON "workspace_webhook_deliveries" ("webhook_id", "created_at" DESC);
CREATE INDEX "workspace_webhook_deliveries_settled_idx"
  ON "workspace_webhook_deliveries" ("created_at")
  WHERE "delivered_at" IS NOT NULL OR "failed_at" IS NOT NULL;

ALTER TABLE "workspace_credential_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_credential_providers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_credential_providers_workspace_scope" ON "workspace_credential_providers"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- FORCE RLS also binds the non-superuser table owner, so the owner-run
-- dispatcher functions below get an exact owner-only policy. The runtime role
-- is never the owner and stays bound to its workspace scope.
ALTER TABLE "workspace_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_webhooks_workspace_scope" ON "workspace_webhooks"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY "workspace_webhooks_dispatcher_owner" ON "workspace_webhooks"
  FOR SELECT
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'workspace_webhooks'::regclass
    )
  );

ALTER TABLE "workspace_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "workspace_webhook_deliveries_workspace_scope" ON "workspace_webhook_deliveries"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY "workspace_webhook_deliveries_dispatcher_owner" ON "workspace_webhook_deliveries"
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'workspace_webhook_deliveries'::regclass
    )
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'workspace_webhook_deliveries'::regclass
    )
  );

REVOKE ALL ON TABLE "workspace_credential_providers" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_webhooks" FROM PUBLIC;
REVOKE ALL ON TABLE "workspace_webhook_deliveries" FROM PUBLIC;

-- Enqueue runs as the session-event writer, inside its transaction and under
-- its exact workspace RLS context, so it can only see that workspace's
-- webhooks and can only insert that workspace's deliveries. The receiver gets
-- a thin event; details stay behind the authenticated API.
CREATE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path FROM CURRENT
AS $enqueue_workspace_webhook_deliveries$
DECLARE
  status_value text := CASE
    WHEN pg_catalog.jsonb_typeof(NEW.payload -> 'status') = 'string'
      THEN pg_catalog.left(NEW.payload ->> 'status', 64)
  END;
  reason_value text := CASE
    WHEN pg_catalog.jsonb_typeof(NEW.payload -> 'reason') = 'string'
      THEN pg_catalog.left(NEW.payload ->> 'reason', 200)
  END;
BEGIN
  BEGIN
    INSERT INTO workspace_webhook_deliveries (
      account_id, workspace_id, webhook_id, event_id, event_type, payload
    )
    SELECT
      webhook.account_id,
      webhook.workspace_id,
      webhook.id,
      NEW.id,
      NEW.type,
      pg_catalog.jsonb_build_object(
        'id', NEW.id,
        'type', NEW.type,
        'workspaceId', NEW.workspace_id,
        'sessionId', NEW.session_id,
        'turnId', NEW.turn_id,
        'sequence', NEW.sequence,
        'occurredAt', pg_catalog.to_char(
          NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'data', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'status', status_value,
          'reason', reason_value
        ))
      )
    FROM workspace_webhooks webhook
    WHERE webhook.account_id = NEW.account_id
      AND webhook.workspace_id = NEW.workspace_id
      AND webhook.enabled
      AND NEW.type = ANY (webhook.event_types)
    ON CONFLICT (webhook_id, event_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- A notification must never abort the lifecycle transaction that caused it.
    RAISE WARNING 'workspace webhook enqueue skipped for event %: %', NEW.id, SQLSTATE;
  END;
  RETURN NULL;
END
$enqueue_workspace_webhook_deliveries$;

-- The dispatcher is one cross-workspace loop. It reaches the outbox only
-- through these owner-run functions; the application role still has no
-- cross-tenant table visibility.
CREATE FUNCTION opengeni_private.claim_workspace_webhook_deliveries_v1(
  p_claim_id uuid,
  p_limit integer,
  p_claim_seconds integer
)
RETURNS TABLE (
  delivery_id uuid,
  account_id uuid,
  workspace_id uuid,
  webhook_id uuid,
  event_id uuid,
  event_type text,
  payload jsonb,
  attempts integer,
  url text,
  secret_encrypted text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $claim_workspace_webhook_deliveries$
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'webhook delivery claim id is required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT delivery.id
    FROM workspace_webhook_deliveries delivery
    JOIN workspace_webhooks webhook
      ON webhook.workspace_id = delivery.workspace_id
     AND webhook.id = delivery.webhook_id
    WHERE delivery.delivered_at IS NULL
      AND delivery.failed_at IS NULL
      AND delivery.next_attempt_at <= pg_catalog.now()
      AND (delivery.claim_until IS NULL OR delivery.claim_until < pg_catalog.now())
      AND webhook.enabled
    ORDER BY delivery.next_attempt_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 32), 100))
  ),
  claimed AS (
    UPDATE workspace_webhook_deliveries delivery
    SET claim_id = p_claim_id,
        claim_until = pg_catalog.now() + pg_catalog.make_interval(
          secs => greatest(5, least(coalesce(p_claim_seconds, 60), 300))
        ),
        attempts = delivery.attempts + 1
    FROM candidates
    WHERE delivery.id = candidates.id
    RETURNING delivery.*
  )
  SELECT
    claimed.id,
    claimed.account_id,
    claimed.workspace_id,
    claimed.webhook_id,
    claimed.event_id,
    claimed.event_type,
    claimed.payload,
    claimed.attempts,
    webhook.url,
    webhook.secret_encrypted
  FROM claimed
  JOIN workspace_webhooks webhook
    ON webhook.workspace_id = claimed.workspace_id
   AND webhook.id = claimed.webhook_id
  ORDER BY claimed.next_attempt_at, claimed.id;
END
$claim_workspace_webhook_deliveries$;

-- NULL error settles success. Otherwise retry with capped exponential backoff
-- until p_max_attempts, then mark the delivery failed. Only the exact claim
-- holder can settle.
CREATE FUNCTION opengeni_private.settle_workspace_webhook_delivery_v1(
  p_delivery_id uuid,
  p_claim_id uuid,
  p_status integer,
  p_error text,
  p_max_attempts integer
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $settle_workspace_webhook_delivery$
  WITH settled AS (
    UPDATE workspace_webhook_deliveries delivery
    SET claim_id = NULL,
        claim_until = NULL,
        last_status = p_status,
        last_error = CASE
          WHEN p_error IS NULL THEN NULL
          ELSE pg_catalog.left(p_error, 2000)
        END,
        delivered_at = CASE WHEN p_error IS NULL THEN pg_catalog.now() END,
        failed_at = CASE
          WHEN p_error IS NOT NULL
            AND delivery.attempts >= greatest(1, least(coalesce(p_max_attempts, 12), 50))
            THEN pg_catalog.now()
        END,
        next_attempt_at = CASE
          WHEN p_error IS NULL THEN delivery.next_attempt_at
          ELSE pg_catalog.now() + pg_catalog.make_interval(
            secs => least(
              3600,
              greatest(5, 5 * power(2, least(greatest(delivery.attempts - 1, 0), 10)))
            )::double precision
          )
        END
    WHERE delivery.id = p_delivery_id
      AND delivery.claim_id = p_claim_id
      AND delivery.delivered_at IS NULL
      AND delivery.failed_at IS NULL
    RETURNING true AS changed
  )
  SELECT coalesce((SELECT changed FROM settled), false);
$settle_workspace_webhook_delivery$;

CREATE FUNCTION opengeni_private.prune_workspace_webhook_deliveries_v1(
  p_retention_seconds integer,
  p_limit integer
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $prune_workspace_webhook_deliveries$
  WITH doomed AS (
    SELECT delivery.id
    FROM workspace_webhook_deliveries delivery
    WHERE (delivery.delivered_at IS NOT NULL OR delivery.failed_at IS NOT NULL)
      AND delivery.created_at < pg_catalog.now() - pg_catalog.make_interval(
        secs => greatest(3600, coalesce(p_retention_seconds, 604800))
      )
    ORDER BY delivery.created_at
    LIMIT greatest(1, least(coalesce(p_limit, 500), 5000))
  ),
  deleted AS (
    DELETE FROM workspace_webhook_deliveries delivery
    USING doomed
    WHERE delivery.id = doomed.id
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$prune_workspace_webhook_deliveries$;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.claim_workspace_webhook_deliveries_v1(uuid, integer, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.settle_workspace_webhook_delivery_v1(uuid, uuid, integer, text, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.prune_workspace_webhook_deliveries_v1(integer, integer)
  FROM PUBLIC;

CREATE TRIGGER "session_events_workspace_webhook_enqueue_v1"
AFTER INSERT ON "session_events"
FOR EACH ROW
WHEN (
  NEW.duplicate_of_event_id IS NULL
  AND NEW.type IN (
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
    'session.status.changed',
    'session.requiresAction',
    'session.humanInput.requested'
  )
)
EXECUTE FUNCTION opengeni_private.enqueue_workspace_webhook_deliveries_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      "workspace_credential_providers",
      "workspace_webhooks",
      "workspace_webhook_deliveries"
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.enqueue_workspace_webhook_deliveries_v1(),
      opengeni_private.claim_workspace_webhook_deliveries_v1(uuid, integer, integer),
      opengeni_private.settle_workspace_webhook_delivery_v1(uuid, uuid, integer, text, integer),
      opengeni_private.prune_workspace_webhook_deliveries_v1(integer, integer)
      TO opengeni_app;
  END IF;
END $$;
