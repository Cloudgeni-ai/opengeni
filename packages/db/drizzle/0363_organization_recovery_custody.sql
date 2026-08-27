-- deployment-mode: rolling
-- Revisioned organization recovery custody and immutable workspace ownership.
-- Recovery can only promote one existing active human membership to co-owner.
-- It cannot transfer workspaces, Personal resources, data, or billing authority.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "organization_recovery_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL,
  "configured_by_membership_id" uuid NOT NULL,
  "configured_by_identity_id" uuid NOT NULL
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "configured_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_policies_membership_fk"
    FOREIGN KEY ("configured_by_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_policies_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "organization_recovery_policies_id_account_unique" UNIQUE ("id", "account_id"),
  CONSTRAINT "organization_recovery_policies_account_revision_unique"
    UNIQUE ("account_id", "revision")
);

CREATE TABLE "organization_recovery_policy_heads" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "current_policy_id" uuid NOT NULL UNIQUE,
  "revision" bigint NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "activated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_policy_heads_policy_fk"
    FOREIGN KEY ("current_policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_policy_heads_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "organization_recovery_custodians" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "membership_id" uuid NOT NULL,
  "canonical_identity_id" uuid NOT NULL
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "enrolled_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_custodians_policy_fk"
    FOREIGN KEY ("policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_custodians_membership_fk"
    FOREIGN KEY ("membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_custodians_ordinal_check" CHECK ("ordinal" BETWEEN 1 AND 3),
  CONSTRAINT "organization_recovery_custodians_policy_ordinal_unique"
    UNIQUE ("policy_id", "ordinal"),
  CONSTRAINT "organization_recovery_custodians_policy_membership_unique"
    UNIQUE ("policy_id", "membership_id"),
  CONSTRAINT "organization_recovery_custodians_policy_identity_unique"
    UNIQUE ("policy_id", "canonical_identity_id"),
  CONSTRAINT "organization_recovery_custodians_id_policy_unique" UNIQUE ("id", "policy_id")
);
CREATE INDEX "organization_recovery_custodians_account_policy_idx"
  ON "organization_recovery_custodians" ("account_id", "policy_id", "ordinal");

CREATE TABLE "organization_recovery_custodian_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "custodian_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "canonical_identity_id" uuid NOT NULL,
  "auth_user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "login_binding_id" uuid NOT NULL
    REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  "membership_authorization_revision" bigint NOT NULL,
  "identity_revision" bigint NOT NULL,
  "auth_revision" bigint NOT NULL,
  "subject_revision" bigint NOT NULL,
  "login_binding_revision" bigint NOT NULL,
  "reauth_operation_id" uuid NOT NULL
    REFERENCES "managed_auth_session_set_operations"("operation_id") ON DELETE RESTRICT,
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_acceptances_policy_fk"
    FOREIGN KEY ("policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_acceptances_custodian_fk"
    FOREIGN KEY ("custodian_id", "policy_id")
    REFERENCES "organization_recovery_custodians"("id", "policy_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_acceptances_membership_fk"
    FOREIGN KEY ("membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_acceptances_revision_check" CHECK (
    "membership_authorization_revision" > 0 AND "identity_revision" > 0
    AND "auth_revision" > 0 AND "subject_revision" > 0
    AND "login_binding_revision" > 0
  )
);
CREATE INDEX "organization_recovery_acceptances_current_idx"
  ON "organization_recovery_custodian_acceptances"
  ("policy_id", "canonical_identity_id", "accepted_at" DESC, "id" DESC);

CREATE TABLE "organization_recovery_operations" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "policy_revision" bigint NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1,
  "state" text NOT NULL DEFAULT 'collecting',
  "target_membership_id" uuid NOT NULL,
  "target_identity_id" uuid NOT NULL
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "target_auth_user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "target_membership_authorization_revision" bigint NOT NULL,
  "target_identity_revision" bigint NOT NULL,
  "target_auth_revision" bigint NOT NULL,
  "target_subject_revision" bigint NOT NULL,
  "started_by_custodian_id" uuid NOT NULL,
  "started_by_identity_id" uuid NOT NULL
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "quorum_at" timestamptz,
  "executable_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "notification_batch_id" uuid,
  "notification_count" integer,
  "notification_digest" text,
  "executed_at" timestamptz,
  "cancelled_at" timestamptz,
  "superseded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_operations_policy_fk"
    FOREIGN KEY ("policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_operations_target_fk"
    FOREIGN KEY ("target_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_operations_starter_fk"
    FOREIGN KEY ("started_by_custodian_id", "policy_id")
    REFERENCES "organization_recovery_custodians"("id", "policy_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_operations_revision_check" CHECK (
    "policy_revision" > 0 AND "revision" > 0
    AND "target_membership_authorization_revision" > 0
    AND "target_identity_revision" > 0 AND "target_auth_revision" > 0
    AND "target_subject_revision" > 0
  ),
  CONSTRAINT "organization_recovery_operations_state_check" CHECK (
    "state" IN ('collecting', 'cooling', 'executed', 'cancelled', 'expired', 'superseded')
  ),
  CONSTRAINT "organization_recovery_operations_time_check" CHECK (
    "expires_at" = "created_at" + interval '30 days'
    AND (
      ("quorum_at" IS NULL AND "executable_at" IS NULL
        AND "notification_batch_id" IS NULL AND "notification_count" IS NULL
        AND "notification_digest" IS NULL)
      OR
      ("quorum_at" IS NOT NULL AND "executable_at" = "quorum_at" + interval '7 days'
        AND "notification_batch_id" IS NOT NULL AND "notification_count" > 0
        AND "notification_digest" ~ '^[0-9a-f]{64}$')
    )
  ),
  CONSTRAINT "organization_recovery_operations_terminal_check" CHECK (
    ("state" = 'executed' AND "executed_at" IS NOT NULL
      AND "cancelled_at" IS NULL AND "superseded_at" IS NULL)
    OR ("state" = 'cancelled' AND "cancelled_at" IS NOT NULL
      AND "executed_at" IS NULL AND "superseded_at" IS NULL)
    OR ("state" = 'superseded' AND "superseded_at" IS NOT NULL
      AND "executed_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("state" IN ('collecting', 'cooling', 'expired')
      AND "executed_at" IS NULL AND "cancelled_at" IS NULL AND "superseded_at" IS NULL)
  ),
  CONSTRAINT "organization_recovery_operations_id_account_unique" UNIQUE ("id", "account_id")
);
CREATE UNIQUE INDEX "organization_recovery_operations_one_live_idx"
  ON "organization_recovery_operations" ("account_id")
  WHERE "state" IN ('collecting', 'cooling');
CREATE INDEX "organization_recovery_operations_account_created_idx"
  ON "organization_recovery_operations" ("account_id", "created_at" DESC, "id" DESC);

CREATE TABLE "organization_recovery_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "operation_revision" bigint NOT NULL,
  "policy_id" uuid NOT NULL,
  "custodian_id" uuid NOT NULL,
  "membership_id" uuid NOT NULL,
  "canonical_identity_id" uuid NOT NULL,
  "auth_user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "login_binding_id" uuid NOT NULL
    REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  "membership_authorization_revision" bigint NOT NULL,
  "identity_revision" bigint NOT NULL,
  "auth_revision" bigint NOT NULL,
  "subject_revision" bigint NOT NULL,
  "login_binding_revision" bigint NOT NULL,
  "custodian_acceptance_id" uuid NOT NULL
    REFERENCES "organization_recovery_custodian_acceptances"("id") ON DELETE RESTRICT,
  "reauth_operation_id" uuid NOT NULL
    REFERENCES "managed_auth_session_set_operations"("operation_id") ON DELETE RESTRICT,
  "approved_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_approvals_operation_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_approvals_custodian_fk"
    FOREIGN KEY ("custodian_id", "policy_id")
    REFERENCES "organization_recovery_custodians"("id", "policy_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_approvals_membership_fk"
    FOREIGN KEY ("membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_approvals_revision_check" CHECK (
    "operation_revision" > 0 AND "membership_authorization_revision" > 0
    AND "identity_revision" > 0 AND "auth_revision" > 0
    AND "subject_revision" > 0 AND "login_binding_revision" > 0
  ),
  CONSTRAINT "organization_recovery_approvals_evidence_unique" UNIQUE (
    "operation_id", "canonical_identity_id", "membership_authorization_revision",
    "identity_revision", "auth_revision", "subject_revision", "login_binding_revision"
  )
);
CREATE INDEX "organization_recovery_approvals_current_idx"
  ON "organization_recovery_approvals"
  ("operation_id", "canonical_identity_id", "approved_at" DESC, "id" DESC);

CREATE TABLE "organization_recovery_command_receipts" (
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "operation_id" uuid NOT NULL,
  "action" text NOT NULL,
  "actor_membership_id" uuid NOT NULL,
  "actor_identity_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "operation_id"),
  CONSTRAINT "organization_recovery_receipts_membership_fk"
    FOREIGN KEY ("actor_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_receipts_identity_fk"
    FOREIGN KEY ("actor_identity_id")
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_receipts_action_check" CHECK (
    "action" IN ('configure_policy', 'accept_custody', 'disable_policy',
      'start_operation', 'approve_operation', 'cancel_operation', 'execute_operation')
  ),
  CONSTRAINT "organization_recovery_receipts_hash_check" CHECK ("input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "organization_recovery_receipts_result_check" CHECK (
    pg_catalog.jsonb_typeof("result") = 'object' AND octet_length("result"::text) <= 65536
  )
);

CREATE TABLE "organization_recovery_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "policy_id" uuid,
  "operation_id" uuid,
  "command_operation_id" uuid,
  "event_type" text NOT NULL,
  "actor_membership_id" uuid,
  "actor_identity_id" uuid,
  "event_revision" bigint NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_events_policy_fk"
    FOREIGN KEY ("policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_events_operation_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_events_membership_fk"
    FOREIGN KEY ("actor_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_events_revision_check" CHECK ("event_revision" > 0),
  CONSTRAINT "organization_recovery_events_type_check" CHECK (
    "event_type" IN ('policy_configured', 'custody_accepted', 'policy_activated',
      'policy_disabled', 'operation_started', 'operation_approved', 'quorum_started',
      'operation_cancelled', 'operation_executed', 'operation_expired',
      'operation_superseded')
  ),
  CONSTRAINT "organization_recovery_events_evidence_check" CHECK (
    pg_catalog.jsonb_typeof("evidence") = 'object' AND octet_length("evidence"::text) <= 8192
  )
);
CREATE UNIQUE INDEX "organization_recovery_events_command_type_unique"
  ON "organization_recovery_events" ("account_id", "command_operation_id", "event_type")
  WHERE "command_operation_id" IS NOT NULL;

CREATE TABLE "organization_recovery_notification_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL,
  "policy_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "recipient_membership_id" uuid NOT NULL,
  "recipient_identity_id" uuid NOT NULL,
  "audience" text NOT NULL,
  "notification_type" text NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "payload_digest" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_outbox_policy_fk"
    FOREIGN KEY ("policy_id", "account_id")
    REFERENCES "organization_recovery_policies"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_outbox_operation_fk"
    FOREIGN KEY ("operation_id", "account_id")
    REFERENCES "organization_recovery_operations"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_outbox_recipient_fk"
    FOREIGN KEY ("recipient_membership_id", "account_id")
    REFERENCES "organization_memberships"("id", "account_id") ON DELETE RESTRICT,
  CONSTRAINT "organization_recovery_outbox_type_check" CHECK (
    "notification_type" = 'recovery_quorum_started'
  ),
  CONSTRAINT "organization_recovery_outbox_digest_check" CHECK (
    "payload_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "organization_recovery_outbox_payload_check" CHECK (
    pg_catalog.jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 8192
  )
);
CREATE INDEX "organization_recovery_outbox_batch_idx"
  ON "organization_recovery_notification_outbox" ("operation_id", "batch_id", "id");

CREATE TABLE "organization_recovery_notification_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "outbox_id" uuid NOT NULL
    REFERENCES "organization_recovery_notification_outbox"("id") ON DELETE RESTRICT,
  "delivery_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "claim_owner" text NOT NULL,
  "attempt_number" integer NOT NULL,
  "lease_expires_at" timestamptz NOT NULL,
  "phase" text NOT NULL,
  "provider_message_id" text,
  "error_class" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_recovery_attempts_provider_check" CHECK (
    "provider" = lower(btrim("provider")) AND length("provider") BETWEEN 1 AND 64
  ),
  CONSTRAINT "organization_recovery_attempts_claim_check" CHECK (
    length(btrim("claim_owner")) BETWEEN 1 AND 256 AND "attempt_number" BETWEEN 1 AND 5
  ),
  CONSTRAINT "organization_recovery_attempts_phase_check" CHECK (
    "phase" IN ('provider_started', 'sent', 'failed', 'outcome_unknown',
      'claim_expired', 'reconciled_sent', 'reconciled_retry')
  ),
  CONSTRAINT "organization_recovery_attempts_error_check" CHECK (
    ("phase" = 'failed' AND "error_class" IS NOT NULL)
    OR ("phase" <> 'failed' AND "error_class" IS NULL)
  ),
  CONSTRAINT "organization_recovery_attempts_delivery_phase_unique"
    UNIQUE ("outbox_id", "delivery_id", "phase")
);

-- Even the migration owner cannot reparent a workspace by issuing direct SQL.
CREATE OR REPLACE FUNCTION reject_workspace_account_id_change()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
    RAISE EXCEPTION 'workspace organization ownership is immutable; transfer is unsupported'
      USING ERRCODE = '0A000';
  END IF;
  RETURN NEW;
END
$body$;

-- Owner-only dispatcher seam. It journals provider_started before returning;
-- the provider call happens outside the transaction and settle appends the
-- terminal phase. Claims are leased and bounded to five attempts. An expired
-- claim is explicitly journaled before another dispatcher may receive the same
-- stable idempotency key. Failed delivery uses bounded exponential pacing;
-- outcome_unknown stays blocked until explicit reconciliation.
CREATE OR REPLACE FUNCTION prepare_organization_recovery_notifications(
  p_provider text, p_claim_owner text, p_limit integer, p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  result jsonb;
  now_value timestamptz := pg_catalog.clock_timestamp();
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
BEGIN
  IF p_provider IS NULL OR p_provider <> lower(btrim(p_provider))
    OR length(p_provider) NOT BETWEEN 1 AND 64
    OR p_claim_owner IS NULL OR length(btrim(p_claim_owner)) NOT BETWEEN 1 AND 256
    OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds NOT BETWEEN 15 AND 300
  THEN
    RAISE EXCEPTION 'organization recovery notification claim is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);

  -- A provider_started lease is not silently forgotten. Its expiry is immutable
  -- evidence that the payload was handed to a dispatcher but was not recorded
  -- as called; the stable provider idempotency key remains unchanged on reclaim.
  WITH stale AS (
    SELECT outbox.id, started.delivery_id, started.provider, started.claim_owner,
      started.attempt_number, started.lease_expires_at
    FROM organization_recovery_notification_outbox outbox
    INNER JOIN LATERAL (
      SELECT attempt.*
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id AND attempt.phase = 'provider_started'
      ORDER BY attempt.attempt_number DESC, attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) started ON true
    WHERE started.lease_expires_at <= now_value
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts terminal
        WHERE terminal.outbox_id = outbox.id
          AND terminal.delivery_id = started.delivery_id
          AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit
    FOR UPDATE OF outbox SKIP LOCKED
  )
  INSERT INTO organization_recovery_notification_attempts (
    outbox_id, delivery_id, provider, claim_owner, attempt_number,
    lease_expires_at, phase, created_at
  ) SELECT
    stale.id, stale.delivery_id, stale.provider, stale.claim_owner,
    stale.attempt_number, stale.lease_expires_at, 'claim_expired', now_value
  FROM stale
  ON CONFLICT (outbox_id, delivery_id, phase) DO NOTHING;

  WITH candidates AS (
    SELECT outbox.id
    FROM organization_recovery_notification_outbox outbox
    LEFT JOIN LATERAL (
      SELECT attempt.phase, attempt.attempt_number, attempt.created_at
      FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
      ORDER BY attempt.created_at DESC, attempt.id DESC
      LIMIT 1
    ) latest ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM organization_recovery_notification_attempts attempt
      WHERE attempt.outbox_id = outbox.id
        AND attempt.phase IN ('sent', 'reconciled_sent')
    )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts ambiguous
        WHERE ambiguous.outbox_id = outbox.id AND ambiguous.phase = 'outcome_unknown'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts reconciliation
            WHERE reconciliation.outbox_id = ambiguous.outbox_id
              AND reconciliation.delivery_id = ambiguous.delivery_id
              AND reconciliation.phase IN ('reconciled_sent', 'reconciled_retry')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
          AND NOT EXISTS (
            SELECT 1 FROM organization_recovery_notification_attempts terminal
            WHERE terminal.outbox_id = started.outbox_id
              AND terminal.delivery_id = started.delivery_id
              AND terminal.phase IN ('sent', 'failed', 'outcome_unknown', 'claim_expired')
          )
      )
      AND (
        SELECT pg_catalog.count(*)
        FROM organization_recovery_notification_attempts started
        WHERE started.outbox_id = outbox.id AND started.phase = 'provider_started'
      ) < 5
      AND (
        latest.phase IS NULL
        OR latest.phase IN ('claim_expired', 'reconciled_retry')
        OR (
          latest.phase = 'failed'
          AND latest.created_at + pg_catalog.make_interval(
            secs => least(900, 60 * (2 ^ greatest(0, latest.attempt_number - 1))::integer)
          ) <= now_value
        )
      )
    ORDER BY outbox.created_at, outbox.id
    LIMIT p_limit FOR UPDATE OF outbox SKIP LOCKED
  ), started AS (
    INSERT INTO organization_recovery_notification_attempts (
      outbox_id, delivery_id, provider, claim_owner, attempt_number,
      lease_expires_at, phase, created_at
    )
    SELECT candidate.id, gen_random_uuid(), p_provider, p_claim_owner,
      1 + (
        SELECT pg_catalog.count(*)::integer
        FROM organization_recovery_notification_attempts prior
        WHERE prior.outbox_id = candidate.id AND prior.phase = 'provider_started'
      ), now_value + pg_catalog.make_interval(secs => p_lease_seconds),
      'provider_started', now_value
    FROM candidates candidate
    RETURNING id, outbox_id, delivery_id, provider, claim_owner,
      attempt_number, lease_expires_at, created_at
  )
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'attemptId', started.id::text,
      'outboxId', outbox.id::text,
      'deliveryId', started.delivery_id::text,
      'provider', started.provider,
      'claimOwner', started.claim_owner,
      'attemptNumber', started.attempt_number,
      'leaseExpiresAt', started.lease_expires_at,
      'idempotencyKey', outbox.idempotency_key,
      'recipientCanonicalIdentityId', outbox.recipient_identity_id::text,
      'notificationType', outbox.notification_type,
      'payloadDigest', outbox.payload_digest,
      'payload', outbox.payload
    ) ORDER BY outbox.created_at, outbox.id
  ), '[]'::jsonb) INTO result
  FROM started
  INNER JOIN organization_recovery_notification_outbox outbox
    ON outbox.id = started.outbox_id;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION settle_organization_recovery_notification(
  p_outbox_id uuid, p_delivery_id uuid, p_claim_owner text, p_phase text,
  p_provider_message_id text, p_error_class text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  prior organization_recovery_notification_attempts%ROWTYPE;
  existing organization_recovery_notification_attempts%ROWTYPE;
  result jsonb;
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
BEGIN
  IF p_outbox_id IS NULL OR p_delivery_id IS NULL
    OR p_claim_owner IS NULL OR length(btrim(p_claim_owner)) NOT BETWEEN 1 AND 256
    OR p_phase NOT IN ('sent', 'failed', 'outcome_unknown')
    OR (p_phase = 'failed' AND nullif(btrim(p_error_class), '') IS NULL)
    OR (p_phase <> 'failed' AND p_error_class IS NOT NULL)
    OR (p_provider_message_id IS NOT NULL AND octet_length(p_provider_message_id) > 1024)
    OR (p_error_class IS NOT NULL AND octet_length(p_error_class) > 256)
  THEN
    RAISE EXCEPTION 'organization recovery notification settlement is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM 1 FROM organization_recovery_notification_outbox outbox
  WHERE outbox.id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization recovery notification delivery is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM organization_recovery_notification_attempts attempt
  WHERE attempt.outbox_id = p_outbox_id AND attempt.delivery_id = p_delivery_id
    AND attempt.phase = 'provider_started' AND attempt.claim_owner = p_claim_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization recovery notification delivery is unavailable'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_recovery_notification_attempts attempt
    WHERE attempt.outbox_id = p_outbox_id AND attempt.delivery_id = p_delivery_id
      AND attempt.phase = 'claim_expired'
  ) THEN
    RAISE EXCEPTION 'organization recovery notification claim is stale'
      USING ERRCODE = '40001';
  END IF;
  SELECT * INTO existing FROM organization_recovery_notification_attempts attempt
  WHERE attempt.outbox_id = p_outbox_id AND attempt.delivery_id = p_delivery_id
    AND attempt.phase IN ('sent', 'failed', 'outcome_unknown')
  ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1;
  IF FOUND THEN
    IF existing.phase = p_phase
      AND existing.provider_message_id IS NOT DISTINCT FROM p_provider_message_id
      AND existing.error_class IS NOT DISTINCT FROM p_error_class
    THEN
      result := pg_catalog.jsonb_build_object(
        'outboxId', p_outbox_id::text, 'deliveryId', p_delivery_id::text,
        'claimOwner', prior.claim_owner, 'attemptNumber', prior.attempt_number,
        'phase', existing.phase, 'providerMessageId', existing.provider_message_id,
        'errorClass', existing.error_class, 'settledAt', existing.created_at,
        'replay', true
      );
      PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN result;
    END IF;
    RAISE EXCEPTION 'organization recovery notification settlement conflicts'
      USING ERRCODE = '23505';
  END IF;
  INSERT INTO organization_recovery_notification_attempts (
    outbox_id, delivery_id, provider, claim_owner, attempt_number,
    lease_expires_at, phase, provider_message_id, error_class
  ) VALUES (
    p_outbox_id, p_delivery_id, prior.provider, prior.claim_owner,
    prior.attempt_number, prior.lease_expires_at, p_phase,
    p_provider_message_id, p_error_class
  ) RETURNING pg_catalog.jsonb_build_object(
    'outboxId', outbox_id::text, 'deliveryId', delivery_id::text,
    'claimOwner', claim_owner, 'attemptNumber', attempt_number,
    'phase', phase, 'providerMessageId', provider_message_id,
    'errorClass', error_class, 'settledAt', created_at, 'replay', false
  ) INTO result;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION reconcile_organization_recovery_notification(
  p_outbox_id uuid, p_delivery_id uuid, p_reconciliation_owner text,
  p_resolution text, p_provider_message_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  ambiguous organization_recovery_notification_attempts%ROWTYPE;
  existing organization_recovery_notification_attempts%ROWTYPE;
  resolved_phase text;
  result jsonb;
  previous_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
BEGIN
  IF p_outbox_id IS NULL OR p_delivery_id IS NULL
    OR p_reconciliation_owner IS NULL
    OR length(btrim(p_reconciliation_owner)) NOT BETWEEN 1 AND 256
    OR p_resolution NOT IN ('sent', 'retry')
    OR (p_resolution = 'retry' AND p_provider_message_id IS NOT NULL)
    OR (p_provider_message_id IS NOT NULL AND octet_length(p_provider_message_id) > 1024)
  THEN
    RAISE EXCEPTION 'organization recovery notification reconciliation is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM 1 FROM organization_recovery_notification_outbox outbox
  WHERE outbox.id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization recovery notification delivery is unavailable'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO ambiguous FROM organization_recovery_notification_attempts attempt
  WHERE attempt.outbox_id = p_outbox_id AND attempt.delivery_id = p_delivery_id
    AND attempt.phase = 'outcome_unknown';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'only an ambiguous notification delivery may be reconciled'
      USING ERRCODE = '42501';
  END IF;
  resolved_phase := CASE WHEN p_resolution = 'sent'
    THEN 'reconciled_sent' ELSE 'reconciled_retry' END;
  SELECT * INTO existing FROM organization_recovery_notification_attempts attempt
  WHERE attempt.outbox_id = p_outbox_id AND attempt.delivery_id = p_delivery_id
    AND attempt.phase IN ('reconciled_sent', 'reconciled_retry')
  ORDER BY attempt.created_at DESC, attempt.id DESC LIMIT 1;
  IF FOUND THEN
    IF existing.phase <> resolved_phase
      OR existing.provider_message_id IS DISTINCT FROM p_provider_message_id
    THEN
      RAISE EXCEPTION 'organization recovery notification reconciliation conflicts'
        USING ERRCODE = '23505';
    END IF;
    result := pg_catalog.jsonb_build_object(
      'outboxId', p_outbox_id::text, 'deliveryId', p_delivery_id::text,
      'reconciliationOwner', existing.claim_owner,
      'attemptNumber', existing.attempt_number,
      'resolution', p_resolution, 'providerMessageId', existing.provider_message_id,
      'reconciledAt', existing.created_at, 'replay', true
    );
    PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
      CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
    RETURN result;
  END IF;
  INSERT INTO organization_recovery_notification_attempts (
    outbox_id, delivery_id, provider, claim_owner, attempt_number,
    lease_expires_at, phase, provider_message_id
  ) VALUES (
    p_outbox_id, p_delivery_id, ambiguous.provider, p_reconciliation_owner,
    ambiguous.attempt_number, ambiguous.lease_expires_at,
    resolved_phase, p_provider_message_id
  ) RETURNING pg_catalog.jsonb_build_object(
    'outboxId', outbox_id::text, 'deliveryId', delivery_id::text,
    'reconciliationOwner', claim_owner, 'attemptNumber', attempt_number,
    'resolution', p_resolution, 'providerMessageId', provider_message_id,
    'reconciledAt', created_at, 'replay', false
  ) INTO result;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RAISE;
END
$body$;

-- Mutation decisions must be based on one stable custody-evidence snapshot. Canonical
-- identity operations serialize revision and binding changes through the identity row;
-- lock every policy custodian in deterministic order before reading acceptances or
-- approvals so a concurrent authority change either commits first and is observed or
-- waits until this recovery command commits.
CREATE OR REPLACE FUNCTION organization_recovery_lock_policy_evidence(
  p_policy_id uuid, p_operation_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $body$
BEGIN
  IF p_policy_id IS NULL THEN
    RAISE EXCEPTION 'organization recovery policy is unavailable' USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM organization_memberships membership
  INNER JOIN organization_recovery_custodians custodian
    ON custodian.membership_id = membership.id
   AND custodian.account_id = membership.account_id
  WHERE custodian.policy_id = p_policy_id
  ORDER BY membership.id
  FOR UPDATE OF membership;

  PERFORM 1
  FROM canonical_human_identity_subjects subject_row
  INNER JOIN organization_memberships membership
    ON membership.subject_id = 'user:' || subject_row.auth_user_id
  INNER JOIN organization_recovery_custodians custodian
    ON custodian.membership_id = membership.id
   AND custodian.account_id = membership.account_id
   AND custodian.canonical_identity_id = subject_row.identity_id
  WHERE custodian.policy_id = p_policy_id
  ORDER BY subject_row.auth_user_id
  FOR UPDATE OF subject_row;

  PERFORM 1
  FROM canonical_human_identities identity_row
  INNER JOIN organization_recovery_custodians custodian
    ON custodian.canonical_identity_id = identity_row.id
  WHERE custodian.policy_id = p_policy_id
  ORDER BY identity_row.id
  FOR UPDATE OF identity_row;

  PERFORM 1
  FROM canonical_human_login_bindings binding
  WHERE binding.id IN (
    SELECT acceptance.login_binding_id
    FROM organization_recovery_custodian_acceptances acceptance
    WHERE acceptance.policy_id = p_policy_id
    UNION
    SELECT approval.login_binding_id
    FROM organization_recovery_approvals approval
    WHERE p_operation_id IS NOT NULL AND approval.operation_id = p_operation_id
  )
  ORDER BY binding.id
  FOR UPDATE OF binding;
END
$body$;

CREATE OR REPLACE FUNCTION organization_recovery_command(p_command jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  action_name text := p_command ->> 'action';
  account_id_value uuid := nullif(p_command ->> 'organizationId', '')::uuid;
  actor_subject text := p_command ->> 'actorSubjectId';
  actor_auth_user_id text := p_command ->> 'actorAuthUserId';
  actor_auth_session_id text := p_command ->> 'actorAuthSessionId';
  command_operation_id uuid := nullif(p_command ->> 'operationId', '')::uuid;
  recovery_operation_id uuid := nullif(p_command ->> 'recoveryOperationId', '')::uuid;
  expected_policy_revision bigint := nullif(p_command ->> 'expectedPolicyRevision', '')::bigint;
  expected_operation_revision bigint := nullif(p_command ->> 'expectedOperationRevision', '')::bigint;
  fence jsonb := p_command -> 'actorFence';
  input_hash_value text;
  now_value timestamptz := pg_catalog.clock_timestamp();
  actor organization_memberships%ROWTYPE;
  actor_identity canonical_human_identities%ROWTYPE;
  actor_subject_row canonical_human_identity_subjects%ROWTYPE;
  receipt organization_recovery_command_receipts%ROWTYPE;
  head_row organization_recovery_policy_heads%ROWTYPE;
  policy_row organization_recovery_policies%ROWTYPE;
  operation_row organization_recovery_operations%ROWTYPE;
  target organization_memberships%ROWTYPE;
  target_identity canonical_human_identities%ROWTYPE;
  target_subject_row canonical_human_identity_subjects%ROWTYPE;
  custodian_row organization_recovery_custodians%ROWTYPE;
  current_acceptance_id uuid;
  recent_proof jsonb;
  custodian_ids uuid[];
  custodian_count integer;
  valid_acceptance_count integer;
  approvals_before integer;
  approvals_after integer;
  new_policy_id uuid;
  new_policy_revision bigint;
  target_membership_id uuid;
  batch_id_value uuid;
  journal_count integer;
  journal_digest text;
  result jsonb;
  item record;
  candidate_identity_id uuid;
  candidate_auth_user_id text;
  candidate_membership organization_memberships%ROWTYPE;
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
BEGIN
  IF p_command IS NULL OR pg_catalog.jsonb_typeof(p_command) <> 'object'
    OR action_name NOT IN ('configure_policy', 'accept_custody', 'disable_policy',
      'start_operation', 'approve_operation', 'cancel_operation', 'execute_operation')
    OR account_id_value IS NULL OR actor_subject IS NULL OR actor_auth_user_id IS NULL
    OR actor_auth_session_id IS NULL
    OR actor_subject <> 'user:' || actor_auth_user_id OR command_operation_id IS NULL
    OR actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR fence IS NULL OR pg_catalog.jsonb_typeof(fence) <> 'object'
  THEN
    RAISE EXCEPTION 'organization recovery command authority is invalid'
      USING ERRCODE = '42501';
  END IF;

  -- First lock is always the selected browser actor's exact lease. The request id is
  -- deliberately excluded from the semantic receipt digest because a retry is
  -- served by a fresh request lease.
  PERFORM managed_auth_actor_mutation_fence(
    fence ->> 'authorityHash', nullif(fence ->> 'actorEpoch', '')::bigint,
    nullif(fence ->> 'requestId', '')::uuid
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || account_id_value::text, 0
  ));
  PERFORM 1 FROM managed_accounts account
  WHERE account.id = account_id_value FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  SELECT * INTO actor FROM organization_memberships membership
  WHERE membership.account_id = account_id_value AND membership.subject_id = actor_subject
  FOR UPDATE;
  IF NOT FOUND OR actor.status <> 'active' OR actor_subject NOT LIKE 'user:%' THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor_subject_row FROM canonical_human_identity_subjects subject_row
  WHERE subject_row.auth_user_id = actor_auth_user_id AND subject_row.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor_identity FROM canonical_human_identities identity_row
  WHERE identity_row.id = actor_subject_row.identity_id FOR UPDATE;
  IF NOT FOUND OR actor_identity.status <> 'active' OR actor_identity.recovery_state <> 'ready' THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;

  input_hash_value := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (p_command - 'actorFence' - 'actorAuthSessionId')::text, 'UTF8'
  )), 'hex');
  SELECT * INTO receipt FROM organization_recovery_command_receipts candidate
  WHERE candidate.account_id = account_id_value
    AND candidate.operation_id = command_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF receipt.action IS DISTINCT FROM action_name
      OR receipt.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'organization recovery operation id was reused with different input'
        USING ERRCODE = '23505';
    END IF;
    PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
      CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
    PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
      CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
    PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
      CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
    RETURN pg_catalog.jsonb_build_object('replay', true, 'overview', receipt.result);
  END IF;

  recent_proof := organization_recovery_assert_recent_reauth(
    fence, actor_subject, actor_auth_session_id, actor_auth_user_id
  );
  IF (recent_proof ->> 'canonicalIdentityId')::uuid <> actor_identity.id
    OR (recent_proof ->> 'identityRevision')::bigint <> actor_identity.identity_revision
    OR (recent_proof ->> 'authRevision')::bigint <> actor_identity.auth_revision
    OR (recent_proof ->> 'subjectRevision')::bigint <> actor_subject_row.revision
  THEN
    RAISE EXCEPTION 'recent reauthentication actor is stale' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO head_row FROM organization_recovery_policy_heads head
  WHERE head.account_id = account_id_value FOR UPDATE;

  IF action_name = 'configure_policy' THEN
    IF actor.role <> 'owner' THEN
      RAISE EXCEPTION 'active organization owner required' USING ERRCODE = '42501';
    END IF;
    IF (head_row.account_id IS NULL
      AND coalesce(expected_policy_revision, 0::bigint) <> 0::bigint)
      OR (head_row.account_id IS NOT NULL AND head_row.revision <> expected_policy_revision)
    THEN
      RAISE EXCEPTION 'organization recovery policy revision is stale' USING ERRCODE = '40001';
    END IF;
    IF pg_catalog.jsonb_typeof(p_command -> 'custodianMembershipIds') <> 'array' THEN
      RAISE EXCEPTION 'exactly three custodians are required' USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(value::uuid ORDER BY ordinality),
      pg_catalog.count(*)::integer
    INTO custodian_ids, custodian_count
    FROM pg_catalog.jsonb_array_elements_text(p_command -> 'custodianMembershipIds')
      WITH ORDINALITY candidate(value, ordinality);
    IF custodian_count <> 3
      OR (SELECT pg_catalog.count(DISTINCT id) FROM pg_catalog.unnest(custodian_ids) id) <> 3
      OR actor.id = ANY(custodian_ids)
    THEN
      RAISE EXCEPTION 'exactly three distinct non-owner custodians are required'
        USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM organization_memberships membership
    WHERE membership.account_id = account_id_value AND membership.id = ANY(custodian_ids)
    ORDER BY membership.id FOR UPDATE;
    SELECT pg_catalog.count(*)::integer, pg_catalog.count(DISTINCT subject_row.identity_id)::integer
    INTO custodian_count, valid_acceptance_count
    FROM organization_memberships membership
    INNER JOIN canonical_human_identity_subjects subject_row
      ON membership.subject_id = 'user:' || subject_row.auth_user_id
     AND subject_row.status = 'active'
    INNER JOIN canonical_human_identities identity_row
      ON identity_row.id = subject_row.identity_id
     AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
    WHERE membership.account_id = account_id_value AND membership.id = ANY(custodian_ids)
      AND membership.status = 'active' AND membership.role <> 'owner';
    IF custodian_count <> 3 OR valid_acceptance_count <> 3 THEN
      RAISE EXCEPTION 'custodians must be distinct active non-owner canonical humans'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM canonical_human_identities identity_row
    WHERE identity_row.id IN (
      SELECT subject_row.identity_id
      FROM organization_memberships membership
      INNER JOIN canonical_human_identity_subjects subject_row
        ON membership.subject_id = 'user:' || subject_row.auth_user_id
      WHERE membership.account_id = account_id_value AND membership.id = ANY(custodian_ids)
    ) ORDER BY identity_row.id FOR UPDATE;

    new_policy_id := gen_random_uuid();
    new_policy_revision := coalesce(head_row.revision, 0::bigint) + 1::bigint;
    INSERT INTO organization_recovery_policies (
      id, account_id, revision, configured_by_membership_id, configured_by_identity_id
    ) VALUES (
      new_policy_id, account_id_value, new_policy_revision, actor.id, actor_identity.id
    );
    FOR item IN
      SELECT id, ordinality::integer AS ordinal
      FROM pg_catalog.unnest(custodian_ids) WITH ORDINALITY candidate(id, ordinality)
      ORDER BY ordinality
    LOOP
      SELECT * INTO candidate_membership
      FROM organization_memberships membership
      WHERE membership.account_id = account_id_value AND membership.id = item.id;
      SELECT subject_row.identity_id, subject_row.auth_user_id
      INTO candidate_identity_id, candidate_auth_user_id
      FROM canonical_human_identity_subjects subject_row
      WHERE candidate_membership.subject_id = 'user:' || subject_row.auth_user_id
        AND subject_row.status = 'active';
      INSERT INTO organization_recovery_custodians (
        account_id, policy_id, ordinal, membership_id, canonical_identity_id
      ) VALUES (
        account_id_value, new_policy_id, item.ordinal,
        candidate_membership.id, candidate_identity_id
      );
    END LOOP;
    WITH superseded AS (
      UPDATE organization_recovery_operations SET
        state = 'superseded', superseded_at = now_value,
        revision = revision + 1, updated_at = now_value
      WHERE account_id = account_id_value AND state IN ('collecting', 'cooling')
      RETURNING account_id, policy_id, id, revision
    )
    INSERT INTO organization_recovery_events (
      account_id, policy_id, operation_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision, evidence
    ) SELECT
      superseded.account_id, superseded.policy_id, superseded.id, command_operation_id,
      'operation_superseded', actor.id, actor_identity.id, superseded.revision,
      pg_catalog.jsonb_build_object('reason', 'policy_rotated')
    FROM superseded;
    INSERT INTO organization_recovery_policy_heads (
      account_id, current_policy_id, revision, enabled, activated_at, updated_at
    ) VALUES (
      account_id_value, new_policy_id, new_policy_revision, true, NULL, now_value
    ) ON CONFLICT (account_id) DO UPDATE SET
      current_policy_id = EXCLUDED.current_policy_id,
      revision = EXCLUDED.revision, enabled = true,
      activated_at = NULL, updated_at = EXCLUDED.updated_at;
    INSERT INTO organization_recovery_events (
      account_id, policy_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision,
      evidence
    ) VALUES (
      account_id_value, new_policy_id, command_operation_id, 'policy_configured',
      actor.id, actor_identity.id, new_policy_revision,
      pg_catalog.jsonb_build_object('custodianCount', 3, 'priorPolicyId', head_row.current_policy_id)
    );

  ELSIF action_name = 'accept_custody' THEN
    IF head_row.account_id IS NULL OR NOT head_row.enabled THEN
      RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO policy_row FROM organization_recovery_policies policy
    WHERE policy.id = head_row.current_policy_id AND policy.account_id = account_id_value;
    IF policy_row.revision <> expected_policy_revision THEN
      RAISE EXCEPTION 'organization recovery policy revision is stale' USING ERRCODE = '40001';
    END IF;
    PERFORM organization_recovery_lock_policy_evidence(policy_row.id, NULL);
    SELECT * INTO custodian_row FROM organization_recovery_custodians custodian
    WHERE custodian.policy_id = policy_row.id
      AND custodian.membership_id = actor.id
      AND custodian.canonical_identity_id = actor_identity.id
    FOR UPDATE;
    IF NOT FOUND OR actor.role = 'owner' THEN
      RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '42501';
    END IF;
    current_acceptance_id := organization_recovery_valid_acceptance_id(
      policy_row.id, actor_identity.id
    );
    IF current_acceptance_id IS NULL THEN
      INSERT INTO organization_recovery_custodian_acceptances (
        account_id, policy_id, custodian_id, membership_id, canonical_identity_id,
        auth_user_id, login_binding_id, membership_authorization_revision,
        identity_revision, auth_revision, subject_revision, login_binding_revision,
        reauth_operation_id, accepted_at
      ) VALUES (
        account_id_value, policy_row.id, custodian_row.id, actor.id, actor_identity.id,
        actor_auth_user_id, (recent_proof ->> 'loginBindingId')::uuid,
        actor.authorization_revision, actor_identity.identity_revision,
        actor_identity.auth_revision, actor_subject_row.revision,
        (recent_proof ->> 'loginBindingRevision')::bigint,
        (recent_proof ->> 'reauthOperationId')::uuid, now_value
      ) RETURNING id INTO current_acceptance_id;
      INSERT INTO organization_recovery_events (
        account_id, policy_id, command_operation_id, event_type,
        actor_membership_id, actor_identity_id, event_revision
      ) VALUES (
        account_id_value, policy_row.id, command_operation_id, 'custody_accepted',
        actor.id, actor_identity.id, policy_row.revision
      );
    END IF;
    SELECT pg_catalog.count(*)::integer INTO valid_acceptance_count
    FROM organization_recovery_custodians custodian
    WHERE custodian.policy_id = policy_row.id
      AND organization_recovery_valid_acceptance_id(
        custodian.policy_id, custodian.canonical_identity_id
      ) IS NOT NULL;
    IF valid_acceptance_count = 3 AND head_row.activated_at IS NULL THEN
      UPDATE organization_recovery_policy_heads SET
        activated_at = now_value, updated_at = now_value
      WHERE account_id = account_id_value AND current_policy_id = policy_row.id;
      INSERT INTO organization_recovery_events (
        account_id, policy_id, command_operation_id, event_type,
        actor_membership_id, actor_identity_id, event_revision
      ) VALUES (
        account_id_value, policy_row.id, command_operation_id, 'policy_activated',
        actor.id, actor_identity.id, policy_row.revision
      );
    END IF;

  ELSIF action_name = 'disable_policy' THEN
    IF actor.role <> 'owner' OR head_row.account_id IS NULL OR NOT head_row.enabled THEN
      RAISE EXCEPTION 'active organization owner required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO policy_row FROM organization_recovery_policies policy
    WHERE policy.id = head_row.current_policy_id AND policy.account_id = account_id_value;
    IF head_row.revision <> expected_policy_revision THEN
      RAISE EXCEPTION 'organization recovery policy revision is stale' USING ERRCODE = '40001';
    END IF;
    UPDATE organization_recovery_policy_heads SET
      enabled = false, revision = revision + 1, updated_at = now_value
    WHERE account_id = account_id_value;
    WITH superseded AS (
      UPDATE organization_recovery_operations SET
        state = 'superseded', superseded_at = now_value,
        revision = revision + 1, updated_at = now_value
      WHERE account_id = account_id_value AND state IN ('collecting', 'cooling')
      RETURNING account_id, policy_id, id, revision
    )
    INSERT INTO organization_recovery_events (
      account_id, policy_id, operation_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision, evidence
    ) SELECT
      superseded.account_id, superseded.policy_id, superseded.id, command_operation_id,
      'operation_superseded', actor.id, actor_identity.id, superseded.revision,
      pg_catalog.jsonb_build_object('reason', 'policy_disabled')
    FROM superseded;
    INSERT INTO organization_recovery_events (
      account_id, policy_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision
    ) VALUES (
      account_id_value, policy_row.id, command_operation_id, 'policy_disabled',
      actor.id, actor_identity.id, policy_row.revision
    );

  ELSIF action_name = 'start_operation' THEN
    IF head_row.account_id IS NULL OR NOT head_row.enabled THEN
      RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '55000';
    END IF;
    recovery_operation_id := coalesce(recovery_operation_id, gen_random_uuid());
    SELECT * INTO policy_row FROM organization_recovery_policies policy
    WHERE policy.id = head_row.current_policy_id AND policy.account_id = account_id_value;
    IF policy_row.revision <> expected_policy_revision THEN
      RAISE EXCEPTION 'organization recovery policy revision is stale' USING ERRCODE = '40001';
    END IF;
    PERFORM organization_recovery_lock_policy_evidence(policy_row.id, NULL);
    SELECT pg_catalog.count(*)::integer INTO valid_acceptance_count
    FROM organization_recovery_custodians custodian
    WHERE custodian.policy_id = policy_row.id
      AND organization_recovery_valid_acceptance_id(
        custodian.policy_id, custodian.canonical_identity_id
      ) IS NOT NULL;
    SELECT * INTO custodian_row FROM organization_recovery_custodians custodian
    WHERE custodian.policy_id = policy_row.id
      AND custodian.membership_id = actor.id
      AND custodian.canonical_identity_id = actor_identity.id
    FOR UPDATE;
    current_acceptance_id := organization_recovery_valid_acceptance_id(
      policy_row.id, actor_identity.id
    );
    IF valid_acceptance_count <> 3 OR custodian_row.id IS NULL OR current_acceptance_id IS NULL THEN
      RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '55000';
    END IF;
    WITH expired AS (
      UPDATE organization_recovery_operations SET
        state = 'expired', revision = revision + 1, updated_at = now_value
      WHERE account_id = account_id_value AND state IN ('collecting', 'cooling')
        AND expires_at <= now_value
      RETURNING account_id, policy_id, id, revision
    )
    INSERT INTO organization_recovery_events (
      account_id, policy_id, operation_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision
    ) SELECT
      expired.account_id, expired.policy_id, expired.id, command_operation_id,
      'operation_expired', actor.id, actor_identity.id, expired.revision
    FROM expired;
    IF EXISTS (
      SELECT 1 FROM organization_recovery_operations operation
      WHERE operation.account_id = account_id_value
        AND operation.state IN ('collecting', 'cooling')
    ) THEN
      RAISE EXCEPTION 'an organization recovery operation is already active'
        USING ERRCODE = '55000';
    END IF;
    target_membership_id := nullif(p_command ->> 'targetMembershipId', '')::uuid;
    SELECT * INTO target FROM organization_memberships membership
    WHERE membership.account_id = account_id_value AND membership.id = target_membership_id
    FOR UPDATE;
    IF NOT FOUND OR target.status <> 'active' OR target.role = 'owner'
      OR target.subject_id NOT LIKE 'user:%'
    THEN
      RAISE EXCEPTION 'organization recovery target is unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO target_subject_row FROM canonical_human_identity_subjects subject_row
    WHERE subject_row.auth_user_id = pg_catalog.substr(target.subject_id, 6)
      AND subject_row.status = 'active' FOR UPDATE;
    SELECT * INTO target_identity FROM canonical_human_identities identity_row
    WHERE identity_row.id = target_subject_row.identity_id FOR UPDATE;
    IF target_subject_row.identity_id IS NULL OR target_identity.status <> 'active'
      OR target_identity.recovery_state <> 'ready'
    THEN
      RAISE EXCEPTION 'organization recovery target is unavailable' USING ERRCODE = '42501';
    END IF;
    INSERT INTO organization_recovery_operations (
      id, account_id, policy_id, policy_revision, target_membership_id,
      target_identity_id, target_auth_user_id, target_membership_authorization_revision,
      target_identity_revision, target_auth_revision, target_subject_revision,
      started_by_custodian_id, started_by_identity_id, expires_at, created_at, updated_at
    ) VALUES (
      recovery_operation_id, account_id_value, policy_row.id, policy_row.revision,
      target.id, target_identity.id, target_subject_row.auth_user_id,
      target.authorization_revision, target_identity.identity_revision,
      target_identity.auth_revision, target_subject_row.revision,
      custodian_row.id, actor_identity.id, now_value + interval '30 days', now_value, now_value
    ) RETURNING * INTO operation_row;
    INSERT INTO organization_recovery_events (
      account_id, policy_id, operation_id, command_operation_id, event_type,
      actor_membership_id, actor_identity_id, event_revision,
      evidence
    ) VALUES (
      account_id_value, policy_row.id, operation_row.id, command_operation_id,
      'operation_started', actor.id, actor_identity.id, operation_row.revision,
      pg_catalog.jsonb_build_object('targetMembershipId', target.id::text)
    );

  ELSIF action_name IN ('approve_operation', 'cancel_operation', 'execute_operation') THEN
    IF recovery_operation_id IS NULL THEN
      RAISE EXCEPTION 'organization recovery operation is unavailable' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO operation_row FROM organization_recovery_operations operation
    WHERE operation.id = recovery_operation_id AND operation.account_id = account_id_value
    FOR UPDATE;
    IF NOT FOUND OR operation_row.revision <> expected_operation_revision THEN
      RAISE EXCEPTION 'organization recovery operation revision is stale' USING ERRCODE = '40001';
    END IF;
    IF operation_row.state NOT IN ('collecting', 'cooling')
      OR operation_row.expires_at <= now_value
    THEN
      RAISE EXCEPTION 'organization recovery operation is unavailable' USING ERRCODE = '55000';
    END IF;
    IF head_row.account_id IS NULL OR NOT head_row.enabled
      OR head_row.current_policy_id <> operation_row.policy_id
    THEN
      RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO policy_row FROM organization_recovery_policies policy
    WHERE policy.id = operation_row.policy_id AND policy.account_id = account_id_value;

    IF action_name = 'cancel_operation' THEN
      IF actor.role <> 'owner' THEN
        RAISE EXCEPTION 'active organization owner required' USING ERRCODE = '42501';
      END IF;
      UPDATE organization_recovery_operations SET
        state = 'cancelled', cancelled_at = now_value,
        revision = revision + 1, updated_at = now_value
      WHERE id = operation_row.id RETURNING * INTO operation_row;
      INSERT INTO organization_recovery_events (
        account_id, policy_id, operation_id, command_operation_id, event_type,
        actor_membership_id, actor_identity_id, event_revision
      ) VALUES (
        account_id_value, policy_row.id, operation_row.id, command_operation_id,
        'operation_cancelled', actor.id, actor_identity.id, operation_row.revision
      );

    ELSE
      PERFORM organization_recovery_lock_policy_evidence(
        policy_row.id, operation_row.id
      );
      SELECT pg_catalog.count(*)::integer INTO valid_acceptance_count
      FROM organization_recovery_custodians custodian
      WHERE custodian.policy_id = policy_row.id
        AND organization_recovery_valid_acceptance_id(
          custodian.policy_id, custodian.canonical_identity_id
        ) IS NOT NULL;
      IF valid_acceptance_count <> 3 THEN
        RAISE EXCEPTION 'organization recovery is unavailable' USING ERRCODE = '55000';
      END IF;
      SELECT * INTO custodian_row FROM organization_recovery_custodians custodian
      WHERE custodian.policy_id = policy_row.id
        AND custodian.membership_id = actor.id
        AND custodian.canonical_identity_id = actor_identity.id
      FOR UPDATE;
      current_acceptance_id := organization_recovery_valid_acceptance_id(
        policy_row.id, actor_identity.id
      );
      IF custodian_row.id IS NULL OR current_acceptance_id IS NULL
        OR operation_row.target_identity_id = actor_identity.id OR actor.role = 'owner'
      THEN
        RAISE EXCEPTION 'organization recovery approval authority is invalid'
          USING ERRCODE = '42501';
      END IF;

      IF action_name = 'approve_operation' THEN
        approvals_before := organization_recovery_valid_approval_count(operation_row.id);
        IF NOT EXISTS (
          SELECT 1 FROM organization_recovery_approvals approval
          WHERE approval.operation_id = operation_row.id
            AND approval.canonical_identity_id = actor_identity.id
            AND approval.membership_authorization_revision = actor.authorization_revision
            AND approval.identity_revision = actor_identity.identity_revision
            AND approval.auth_revision = actor_identity.auth_revision
            AND approval.subject_revision = actor_subject_row.revision
            AND approval.custodian_acceptance_id = current_acceptance_id
        ) THEN
          INSERT INTO organization_recovery_approvals (
            account_id, operation_id, operation_revision, policy_id, custodian_id,
            membership_id, canonical_identity_id, auth_user_id, login_binding_id,
            membership_authorization_revision, identity_revision, auth_revision,
            subject_revision, login_binding_revision, custodian_acceptance_id,
            reauth_operation_id, approved_at
          ) VALUES (
            account_id_value, operation_row.id, operation_row.revision,
            policy_row.id, custodian_row.id, actor.id, actor_identity.id,
            actor_auth_user_id, (recent_proof ->> 'loginBindingId')::uuid,
            actor.authorization_revision, actor_identity.identity_revision,
            actor_identity.auth_revision, actor_subject_row.revision,
            (recent_proof ->> 'loginBindingRevision')::bigint,
            current_acceptance_id, (recent_proof ->> 'reauthOperationId')::uuid, now_value
          );
          approvals_after := organization_recovery_valid_approval_count(operation_row.id);
          UPDATE organization_recovery_operations SET
            revision = revision + 1, updated_at = now_value
          WHERE id = operation_row.id RETURNING * INTO operation_row;
          INSERT INTO organization_recovery_events (
            account_id, policy_id, operation_id, command_operation_id, event_type,
            actor_membership_id, actor_identity_id, event_revision
          ) VALUES (
            account_id_value, policy_row.id, operation_row.id, command_operation_id,
            'operation_approved', actor.id, actor_identity.id, operation_row.revision
          );

          IF approvals_before < 2 AND approvals_after >= 2 THEN
            batch_id_value := gen_random_uuid();
            WITH raw_recipients AS (
              SELECT membership.id AS membership_id, subject_row.identity_id, 'owner'::text AS audience
              FROM organization_memberships membership
              INNER JOIN canonical_human_identity_subjects subject_row
                ON membership.subject_id = 'user:' || subject_row.auth_user_id
               AND subject_row.status = 'active'
              INNER JOIN canonical_human_identities identity_row
                ON identity_row.id = subject_row.identity_id
               AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
              WHERE membership.account_id = account_id_value
                AND membership.status = 'active' AND membership.role = 'owner'
              UNION ALL
              SELECT custodian.membership_id, custodian.canonical_identity_id, 'custodian'::text
              FROM organization_recovery_custodians custodian
              WHERE custodian.policy_id = policy_row.id
              UNION ALL
              SELECT operation_row.target_membership_id, operation_row.target_identity_id,
                'target'::text
            ), recipients AS (
              SELECT pg_catalog.min(membership_id::text)::uuid AS membership_id,
                identity_id,
                pg_catalog.string_agg(DISTINCT audience, ',' ORDER BY audience) AS audience
              FROM raw_recipients GROUP BY identity_id
            ), payloads AS (
              SELECT recipient.*,
                pg_catalog.jsonb_build_object(
                  'organizationId', account_id_value::text,
                  'operationId', operation_row.id::text,
                  'targetMembershipId', operation_row.target_membership_id::text,
                  'quorumAt', now_value,
                  'cooldownEndsAt', now_value + interval '7 days',
                  'authorityGained', 'organization_owner',
                  'existingOwnersPreserved', true,
                  'personalContentTransferred', false,
                  'workspaceTransferred', false,
                  'billingTransferred', false
                ) AS payload
              FROM recipients recipient
            )
            INSERT INTO organization_recovery_notification_outbox (
              account_id, policy_id, operation_id, batch_id,
              recipient_membership_id, recipient_identity_id, audience,
              notification_type, idempotency_key, payload_digest, payload, created_at
            ) SELECT
              account_id_value, policy_row.id, operation_row.id, batch_id_value,
              payload.membership_id, payload.identity_id, payload.audience,
              'recovery_quorum_started',
              'organization-recovery:' || operation_row.id::text || ':'
                || batch_id_value::text || ':' || payload.identity_id::text,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                payload.payload::text, 'UTF8'
              )), 'hex'), payload.payload, now_value
            FROM payloads payload;
            SELECT pg_catalog.count(*)::integer,
              pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                pg_catalog.string_agg(
                  outbox.id::text || ':' || outbox.payload_digest, ',' ORDER BY outbox.id
                ), 'UTF8'
              )), 'hex')
            INTO journal_count, journal_digest
            FROM organization_recovery_notification_outbox outbox
            WHERE outbox.operation_id = operation_row.id AND outbox.batch_id = batch_id_value;
            IF journal_count < 1 OR journal_digest IS NULL THEN
              RAISE EXCEPTION 'organization recovery notification journal is unavailable'
                USING ERRCODE = '55000';
            END IF;
            UPDATE organization_recovery_operations SET
              state = 'cooling', quorum_at = now_value,
              executable_at = now_value + interval '7 days',
              notification_batch_id = batch_id_value,
              notification_count = journal_count,
              notification_digest = journal_digest,
              revision = revision + 1, updated_at = now_value
            WHERE id = operation_row.id RETURNING * INTO operation_row;
            INSERT INTO organization_recovery_events (
              account_id, policy_id, operation_id, command_operation_id, event_type,
              actor_membership_id, actor_identity_id, event_revision,
              evidence
            ) VALUES (
              account_id_value, policy_row.id, operation_row.id, command_operation_id,
              'quorum_started', actor.id, actor_identity.id, operation_row.revision,
              pg_catalog.jsonb_build_object(
                'notificationBatchId', batch_id_value::text,
                'notificationCount', journal_count,
                'notificationDigest', journal_digest,
                'cooldownDays', 7
              )
            );
          END IF;
        END IF;

      ELSE
        -- Execute revalidates the complete policy, target, quorum, cooldown and
        -- exact immutable notification journal before the sole role update.
        approvals_after := organization_recovery_valid_approval_count(operation_row.id);
        IF valid_acceptance_count <> 3 OR approvals_after < 2
          OR operation_row.quorum_at IS NULL OR operation_row.executable_at > now_value
          OR NOT EXISTS (
            SELECT 1 FROM organization_recovery_approvals approval
            WHERE approval.operation_id = operation_row.id
              AND approval.canonical_identity_id = actor_identity.id
              AND approval.custodian_acceptance_id = current_acceptance_id
              AND approval.membership_authorization_revision = actor.authorization_revision
              AND approval.identity_revision = actor_identity.identity_revision
              AND approval.auth_revision = actor_identity.auth_revision
              AND approval.subject_revision = actor_subject_row.revision
          )
        THEN
          RAISE EXCEPTION 'organization recovery execution is unavailable'
            USING ERRCODE = '55000';
        END IF;
        SELECT * INTO target FROM organization_memberships membership
        WHERE membership.account_id = account_id_value
          AND membership.id = operation_row.target_membership_id
        FOR UPDATE;
        SELECT * INTO target_subject_row FROM canonical_human_identity_subjects subject_row
        WHERE subject_row.auth_user_id = operation_row.target_auth_user_id FOR UPDATE;
        SELECT * INTO target_identity FROM canonical_human_identities identity_row
        WHERE identity_row.id = operation_row.target_identity_id FOR UPDATE;
        IF target.id IS NULL OR target.status <> 'active' OR target.role = 'owner'
          OR target.authorization_revision <> operation_row.target_membership_authorization_revision
          OR target_subject_row.identity_id <> operation_row.target_identity_id
          OR target_subject_row.status <> 'active'
          OR target_subject_row.revision <> operation_row.target_subject_revision
          OR target_identity.status <> 'active' OR target_identity.recovery_state <> 'ready'
          OR target_identity.identity_revision <> operation_row.target_identity_revision
          OR target_identity.auth_revision <> operation_row.target_auth_revision
        THEN
          RAISE EXCEPTION 'organization recovery target is unavailable' USING ERRCODE = '55000';
        END IF;
        SELECT pg_catalog.count(*)::integer,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.string_agg(
              outbox.id::text || ':' || outbox.payload_digest, ',' ORDER BY outbox.id
            ), 'UTF8'
          )), 'hex')
        INTO journal_count, journal_digest
        FROM organization_recovery_notification_outbox outbox
        WHERE outbox.operation_id = operation_row.id
          AND outbox.batch_id = operation_row.notification_batch_id;
        IF journal_count IS DISTINCT FROM operation_row.notification_count
          OR journal_digest IS DISTINCT FROM operation_row.notification_digest
        THEN
          RAISE EXCEPTION 'organization recovery notification journal is invalid'
            USING ERRCODE = '55000';
        END IF;
        UPDATE organization_memberships SET
          role = 'owner', authorization_revision = authorization_revision + 1,
          updated_at = now_value
        WHERE id = target.id AND account_id = account_id_value
          AND authorization_revision = operation_row.target_membership_authorization_revision;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization recovery target revision is stale' USING ERRCODE = '40001';
        END IF;
        UPDATE organization_recovery_operations SET
          state = 'executed', executed_at = now_value,
          revision = revision + 1, updated_at = now_value
        WHERE id = operation_row.id AND state = 'cooling'
        RETURNING * INTO operation_row;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'organization recovery execution is unavailable'
            USING ERRCODE = '55000';
        END IF;
        INSERT INTO organization_recovery_events (
          account_id, policy_id, operation_id, command_operation_id, event_type,
          actor_membership_id, actor_identity_id, event_revision,
          evidence
        ) VALUES (
          account_id_value, policy_row.id, operation_row.id, command_operation_id,
          'operation_executed', actor.id, actor_identity.id, operation_row.revision,
          pg_catalog.jsonb_build_object(
            'promotedMembershipId', target.id::text,
            'authorityGained', 'organization_owner',
            'existingOwnersPreserved', true,
            'personalContentTransferred', false,
            'workspaceTransferred', false,
            'billingTransferred', false
          )
        );
      END IF;
    END IF;
  END IF;

  result := organization_recovery_overview_json(
    account_id_value, actor_subject,
    (recent_proof ->> 'reauthenticatedAt')::timestamptz
  );
  INSERT INTO organization_recovery_command_receipts (
    account_id, operation_id, action, actor_membership_id,
    actor_identity_id, input_hash, result, created_at
  ) VALUES (
    account_id_value, command_operation_id, action_name, actor.id,
    actor_identity.id, input_hash_value, result, now_value
  );
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  RETURN pg_catalog.jsonb_build_object('replay', false, 'overview', result);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  RAISE;
END
$body$;

CREATE TRIGGER reject_workspace_account_id_change
  BEFORE UPDATE OF account_id ON "workspaces"
  FOR EACH ROW EXECUTE FUNCTION reject_workspace_account_id_change();

CREATE OR REPLACE FUNCTION organization_recovery_append_only()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'organization recovery evidence is append-only' USING ERRCODE = '42501';
END
$body$;

CREATE TRIGGER organization_recovery_policies_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_policies"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_custodians_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_custodians"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_custodian_acceptances"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_approvals_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_approvals"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_receipts_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_events_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_events"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_outbox_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_notification_outbox"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();
CREATE TRIGGER organization_recovery_attempts_append_only
  BEFORE UPDATE OR DELETE ON "organization_recovery_notification_attempts"
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_append_only();

CREATE OR REPLACE FUNCTION organization_recovery_exactly_three_custodians()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  policy_id_value uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  previous_marker text := pg_catalog.current_setting('opengeni.organization_recovery_lifecycle', true);
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  IF (SELECT pg_catalog.count(*) FROM organization_recovery_custodians custodian
      WHERE custodian.policy_id = policy_id_value) <> 3 THEN
    RAISE EXCEPTION 'an organization recovery policy must contain exactly three custodians'
      USING ERRCODE = '23514';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
  RAISE;
END
$body$;
CREATE CONSTRAINT TRIGGER organization_recovery_exactly_three_custodians
  AFTER INSERT OR UPDATE ON "organization_recovery_policies"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION organization_recovery_exactly_three_custodians();

DO $organization_recovery_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_recovery_policies', 'organization_recovery_policy_heads',
    'organization_recovery_custodians', 'organization_recovery_custodian_acceptances',
    'organization_recovery_operations', 'organization_recovery_approvals',
    'organization_recovery_command_receipts', 'organization_recovery_events',
    'organization_recovery_notification_outbox', 'organization_recovery_notification_attempts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY organization_recovery_lifecycle ON %I '
      || 'USING (current_setting(''opengeni.organization_recovery_lifecycle'', true) = ''active'') '
      || 'WITH CHECK (current_setting(''opengeni.organization_recovery_lifecycle'', true) = ''active'')',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE %I FROM PUBLIC', table_name);
  END LOOP;
END
$organization_recovery_rls$;

-- The latest acceptance is valid only while every membership, canonical-human,
-- subject, login-binding, and auth revision still exactly matches its evidence.
CREATE OR REPLACE FUNCTION organization_recovery_valid_acceptance_id(
  p_policy_id uuid, p_identity_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  acceptance_id_value uuid;
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT acceptance.id INTO acceptance_id_value
  FROM organization_recovery_custodian_acceptances acceptance
  INNER JOIN organization_recovery_custodians custodian
    ON custodian.id = acceptance.custodian_id
   AND custodian.policy_id = acceptance.policy_id
   AND custodian.membership_id = acceptance.membership_id
   AND custodian.canonical_identity_id = acceptance.canonical_identity_id
  INNER JOIN organization_memberships membership
    ON membership.id = acceptance.membership_id
   AND membership.account_id = acceptance.account_id
  INNER JOIN canonical_human_identity_subjects subject_row
    ON subject_row.auth_user_id = acceptance.auth_user_id
   AND subject_row.identity_id = acceptance.canonical_identity_id
  INNER JOIN canonical_human_identities identity_row
    ON identity_row.id = acceptance.canonical_identity_id
  INNER JOIN canonical_human_login_bindings binding
    ON binding.id = acceptance.login_binding_id
   AND binding.identity_id = acceptance.canonical_identity_id
  WHERE acceptance.policy_id = p_policy_id
    AND acceptance.canonical_identity_id = p_identity_id
    AND membership.subject_id = 'user:' || acceptance.auth_user_id
    AND membership.status = 'active' AND membership.role <> 'owner'
    AND membership.authorization_revision = acceptance.membership_authorization_revision
    AND subject_row.status = 'active' AND subject_row.revision = acceptance.subject_revision
    AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
    AND identity_row.identity_revision = acceptance.identity_revision
    AND identity_row.auth_revision = acceptance.auth_revision
    AND binding.status = 'active' AND binding.revision = acceptance.login_binding_revision
  ORDER BY acceptance.accepted_at DESC, acceptance.id DESC
  LIMIT 1;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RETURN acceptance_id_value;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION organization_recovery_valid_approval_count(
  p_operation_id uuid
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  approval_count integer;
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT pg_catalog.count(DISTINCT approval.canonical_identity_id)::integer
  INTO approval_count
  FROM organization_recovery_approvals approval
  INNER JOIN organization_recovery_operations operation
    ON operation.id = approval.operation_id
   AND operation.account_id = approval.account_id
   AND operation.policy_id = approval.policy_id
  INNER JOIN organization_recovery_custodians custodian
    ON custodian.id = approval.custodian_id
   AND custodian.policy_id = approval.policy_id
   AND custodian.membership_id = approval.membership_id
   AND custodian.canonical_identity_id = approval.canonical_identity_id
  INNER JOIN organization_memberships membership
    ON membership.id = approval.membership_id
   AND membership.account_id = approval.account_id
  INNER JOIN canonical_human_identity_subjects subject_row
    ON subject_row.auth_user_id = approval.auth_user_id
   AND subject_row.identity_id = approval.canonical_identity_id
  INNER JOIN canonical_human_identities identity_row
    ON identity_row.id = approval.canonical_identity_id
  INNER JOIN canonical_human_login_bindings binding
    ON binding.id = approval.login_binding_id
   AND binding.identity_id = approval.canonical_identity_id
  WHERE approval.operation_id = p_operation_id
    AND approval.canonical_identity_id <> operation.target_identity_id
    AND membership.subject_id = 'user:' || approval.auth_user_id
    AND membership.status = 'active' AND membership.role <> 'owner'
    AND membership.authorization_revision = approval.membership_authorization_revision
    AND subject_row.status = 'active' AND subject_row.revision = approval.subject_revision
    AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
    AND identity_row.identity_revision = approval.identity_revision
    AND identity_row.auth_revision = approval.auth_revision
    AND binding.status = 'active' AND binding.revision = approval.login_binding_revision
    AND organization_recovery_valid_acceptance_id(
      approval.policy_id, approval.canonical_identity_id
    ) = approval.custodian_acceptance_id;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RETURN coalesce(approval_count, 0);
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RAISE;
END
$body$;

-- A proof is recent only when it is the current selected slot's exact
-- complete_reauth operation and every stamped identity authority is still live.
CREATE OR REPLACE FUNCTION organization_recovery_resolve_recent_reauth(
  p_fence jsonb, p_actor_subject text, p_auth_session_id text, p_auth_user_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  authority_hash_value text := p_fence ->> 'authorityHash';
  actor_epoch_value bigint := nullif(p_fence ->> 'actorEpoch', '')::bigint;
  result jsonb;
  previous_managed_marker text := pg_catalog.current_setting(
    'opengeni.managed_auth_session_set_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
BEGIN
  IF p_fence IS NULL OR pg_catalog.jsonb_typeof(p_fence) <> 'object'
    OR authority_hash_value !~ '^[0-9a-f]{64}$' OR actor_epoch_value < 1
    OR p_auth_session_id IS NULL OR p_auth_user_id IS NULL
    OR p_actor_subject <> 'user:' || p_auth_user_id
  THEN
    RETURN NULL;
  END IF;
  PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  SELECT pg_catalog.jsonb_build_object(
    'sessionSetId', session_set.id::text,
    'generation', session_set.generation::text,
    'actorEpoch', session_set.actor_epoch::text,
    'slotId', slot.id::text,
    'authSessionId', auth_session.id,
    'authUserId', auth_session.user_id,
    'canonicalIdentityId', identity_row.id::text,
    'identityRevision', identity_row.identity_revision::text,
    'authRevision', identity_row.auth_revision::text,
    'subjectRevision', subject_row.revision::text,
    'loginBindingId', binding.id::text,
    'loginBindingRevision', binding.revision::text,
    'reauthOperationId', operation.operation_id::text,
    'reauthenticatedAt', operation.created_at
  ) INTO result
  FROM managed_auth_session_sets session_set
  INNER JOIN managed_auth_browser_installations installation
    ON installation.id = session_set.installation_id
  INNER JOIN managed_auth_login_slots slot
    ON slot.id = session_set.selected_slot_id
   AND slot.session_set_id = session_set.id
  INNER JOIN auth_sessions auth_session
    ON auth_session.id = slot.auth_session_id
  INNER JOIN canonical_human_identity_subjects subject_row
    ON subject_row.auth_user_id = auth_session.user_id
   AND subject_row.identity_id = slot.identity_id
  INNER JOIN canonical_human_identities identity_row
    ON identity_row.id = slot.identity_id
  INNER JOIN canonical_human_login_bindings binding
    ON binding.id = slot.login_binding_id
   AND binding.identity_id = slot.identity_id
  INNER JOIN managed_auth_session_set_operations operation
    ON operation.session_set_id = session_set.id
  WHERE session_set.authority_hash = authority_hash_value
    AND session_set.actor_epoch = actor_epoch_value
    AND session_set.state = 'ready' AND session_set.revoked_at IS NULL
    AND session_set.idle_expires_at > pg_catalog.clock_timestamp()
    AND session_set.absolute_expires_at > pg_catalog.clock_timestamp()
    AND installation.revoked_at IS NULL
    AND installation.idle_expires_at > pg_catalog.clock_timestamp()
    AND installation.absolute_expires_at > pg_catalog.clock_timestamp()
    AND slot.status = 'active' AND slot.auth_session_id = p_auth_session_id
    AND slot.auth_user_id = p_auth_user_id
    AND auth_session.user_id = p_auth_user_id
    AND auth_session.expires_at > pg_catalog.clock_timestamp()
    AND auth_session.identity_id = slot.identity_id
    AND auth_session.identity_revision = slot.identity_revision
    AND auth_session.auth_revision = slot.auth_revision
    AND auth_session.login_binding_id = slot.login_binding_id
    AND auth_session.login_binding_revision = slot.login_binding_revision
    AND subject_row.status = 'active'
    AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
    AND identity_row.identity_revision = slot.identity_revision
    AND identity_row.auth_revision = slot.auth_revision
    AND binding.status = 'active' AND binding.revision = slot.login_binding_revision
    AND operation.operation_type = 'complete_reauth'
    AND operation.target_slot_id = session_set.selected_slot_id
    AND operation.result_generation = session_set.generation
    AND operation.result_actor_epoch = session_set.actor_epoch
    AND operation.outcome IN ('applied', 'converged')
    AND operation.created_at >= pg_catalog.clock_timestamp() - interval '10 minutes'
    AND operation.created_at <= pg_catalog.clock_timestamp()
  ORDER BY operation.created_at DESC, operation.operation_id DESC
  LIMIT 1;
  PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle',
    CASE WHEN previous_managed_marker IS NULL THEN '' ELSE previous_managed_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle',
    CASE WHEN previous_managed_marker IS NULL THEN '' ELSE previous_managed_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION organization_recovery_assert_recent_reauth(
  p_fence jsonb, p_actor_subject text, p_auth_session_id text, p_auth_user_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  result jsonb;
BEGIN
  result := organization_recovery_resolve_recent_reauth(
    p_fence, p_actor_subject, p_auth_session_id, p_auth_user_id
  );
  IF result IS NULL THEN
    RAISE EXCEPTION 'recent reauthentication is required' USING ERRCODE = '42501';
  END IF;
  RETURN result;
END
$body$;

CREATE OR REPLACE FUNCTION organization_recovery_valid_approvals_json(
  p_operation_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  result jsonb;
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  WITH current_approvals AS (
    SELECT DISTINCT ON (approval.canonical_identity_id)
      approval.membership_id, approval.canonical_identity_id, approval.approved_at, approval.id,
      auth_user.name, auth_user.email
    FROM organization_recovery_approvals approval
    INNER JOIN organization_recovery_operations operation
      ON operation.id = approval.operation_id
     AND operation.account_id = approval.account_id
     AND operation.policy_id = approval.policy_id
    INNER JOIN organization_recovery_custodians custodian
      ON custodian.id = approval.custodian_id
     AND custodian.policy_id = approval.policy_id
     AND custodian.membership_id = approval.membership_id
     AND custodian.canonical_identity_id = approval.canonical_identity_id
    INNER JOIN organization_memberships membership
      ON membership.id = approval.membership_id
     AND membership.account_id = approval.account_id
    INNER JOIN canonical_human_identity_subjects subject_row
      ON subject_row.auth_user_id = approval.auth_user_id
     AND subject_row.identity_id = approval.canonical_identity_id
    INNER JOIN canonical_human_identities identity_row
      ON identity_row.id = approval.canonical_identity_id
    INNER JOIN canonical_human_login_bindings binding
      ON binding.id = approval.login_binding_id
     AND binding.identity_id = approval.canonical_identity_id
    INNER JOIN auth_users auth_user ON auth_user.id = approval.auth_user_id
    WHERE approval.operation_id = p_operation_id
      AND approval.canonical_identity_id <> operation.target_identity_id
      AND membership.subject_id = 'user:' || approval.auth_user_id
      AND membership.status = 'active' AND membership.role <> 'owner'
      AND membership.authorization_revision = approval.membership_authorization_revision
      AND subject_row.status = 'active' AND subject_row.revision = approval.subject_revision
      AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
      AND identity_row.identity_revision = approval.identity_revision
      AND identity_row.auth_revision = approval.auth_revision
      AND binding.status = 'active' AND binding.revision = approval.login_binding_revision
      AND organization_recovery_valid_acceptance_id(
        approval.policy_id, approval.canonical_identity_id
      ) = approval.custodian_acceptance_id
    ORDER BY approval.canonical_identity_id, approval.approved_at DESC, approval.id DESC
  )
  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'membershipId', approval.membership_id::text,
      'name', approval.name,
      'email', approval.email,
      'approvedAt', approval.approved_at
    ) ORDER BY approval.approved_at, approval.id
  ), '[]'::jsonb) INTO result
  FROM current_approvals approval;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION organization_recovery_overview_json(
  p_account_id uuid, p_actor_subject text, p_recent_reauthentication_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  head_row organization_recovery_policy_heads%ROWTYPE;
  policy_row organization_recovery_policies%ROWTYPE;
  operation_row organization_recovery_operations%ROWTYPE;
  custodian_rows jsonb := '[]'::jsonb;
  eligible_member_rows jsonb := '[]'::jsonb;
  eligible_member_count integer := 0;
  valid_acceptances integer := 0;
  valid_approvals integer := 0;
  policy_state text;
  operation_state text;
  target_current boolean := false;
  target_name text;
  target_email text;
  approvals_rows jsonb := '[]'::jsonb;
  actor_membership organization_memberships%ROWTYPE;
  actor_subject_row canonical_human_identity_subjects%ROWTYPE;
  actor_identity canonical_human_identities%ROWTYPE;
  actor_is_custodian boolean := false;
  actor_has_acceptance boolean := false;
  actor_has_approval boolean := false;
  notification_journaled boolean := false;
  actual_notification_count integer := 0;
  actual_notification_digest text;
  capability_configure boolean := false;
  capability_accept boolean := false;
  capability_disable boolean := false;
  capability_start boolean := false;
  capability_approve boolean := false;
  capability_cancel boolean := false;
  capability_execute boolean := false;
  has_recent_reauthentication boolean := p_recent_reauthentication_at IS NOT NULL;
  now_value timestamptz := pg_catalog.clock_timestamp();
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  SELECT * INTO actor_membership FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.subject_id = p_actor_subject
    AND membership.status = 'active' FOR KEY SHARE;
  IF actor_membership.id IS NULL OR p_actor_subject NOT LIKE 'user:%' THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_actor_subject LIKE 'user:%' THEN
    SELECT * INTO actor_subject_row FROM canonical_human_identity_subjects subject_row
    WHERE subject_row.auth_user_id = pg_catalog.substr(p_actor_subject, 6)
      AND subject_row.status = 'active' FOR KEY SHARE;
    IF actor_subject_row.identity_id IS NOT NULL THEN
      SELECT * INTO actor_identity FROM canonical_human_identities identity_row
      WHERE identity_row.id = actor_subject_row.identity_id
        AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
      FOR KEY SHARE;
    END IF;
  END IF;
  capability_configure := has_recent_reauthentication
    AND actor_membership.role = 'owner' AND actor_identity.id IS NOT NULL;
  SELECT pg_catalog.count(*)::integer,
    coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'membershipId', membership.id::text,
        'name', auth_user.name,
        'email', auth_user.email
      ) ORDER BY lower(coalesce(auth_user.name, auth_user.email, membership.subject_id)),
        membership.id
    ), '[]'::jsonb)
  INTO eligible_member_count, eligible_member_rows
  FROM organization_memberships membership
  INNER JOIN canonical_human_identity_subjects subject_row
    ON membership.subject_id = 'user:' || subject_row.auth_user_id
   AND subject_row.status = 'active'
  INNER JOIN canonical_human_identities identity_row
    ON identity_row.id = subject_row.identity_id
   AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
  INNER JOIN auth_users auth_user ON auth_user.id = subject_row.auth_user_id
  WHERE membership.account_id = p_account_id
    AND membership.status = 'active' AND membership.role <> 'owner';
  IF eligible_member_count > 1000 THEN
    RAISE EXCEPTION 'organization recovery target inventory exceeds the bounded projection'
      USING ERRCODE = '54000';
  END IF;
  SELECT * INTO head_row FROM organization_recovery_policy_heads head
  WHERE head.account_id = p_account_id;
  IF NOT FOUND THEN
    IF actor_membership.role <> 'owner' THEN
      RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
    END IF;
    PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
      CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
    PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
      CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
    PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
      CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
    RETURN pg_catalog.jsonb_build_object(
      'organizationId', p_account_id::text, 'policy', NULL, 'operation', NULL,
      'availability', 'recovery_unavailable', 'unavailableReason', 'no_policy',
      'recentReauthenticationAt', p_recent_reauthentication_at,
      'eligibleMembers', eligible_member_rows,
      'capabilities', pg_catalog.jsonb_build_object(
        'configure', capability_configure, 'accept', false, 'disable', false,
        'start', false, 'approve', false, 'cancel', false, 'execute', false
      )
    );
  END IF;
  SELECT * INTO policy_row FROM organization_recovery_policies policy
  WHERE policy.id = head_row.current_policy_id AND policy.account_id = p_account_id;
  SELECT pg_catalog.count(*) FILTER (WHERE current_acceptance.id IS NOT NULL)::integer,
    coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'ordinal', custodian.ordinal,
        'membershipId', custodian.membership_id::text,
        'name', auth_user.name,
        'email', auth_user.email,
        'enrollmentState', CASE
          WHEN current_acceptance.id IS NOT NULL THEN 'accepted'
          WHEN current_eligibility.eligible THEN 'pending_acceptance'
          ELSE 'ineligible'
        END,
        'acceptedAt', current_acceptance.accepted_at
      ) ORDER BY custodian.ordinal
    ), '[]'::jsonb)
  INTO valid_acceptances, custodian_rows
  FROM organization_recovery_custodians custodian
  INNER JOIN organization_memberships membership
    ON membership.id = custodian.membership_id AND membership.account_id = custodian.account_id
  LEFT JOIN auth_users auth_user ON membership.subject_id = 'user:' || auth_user.id
  LEFT JOIN LATERAL (
    SELECT acceptance.id, acceptance.accepted_at
    FROM organization_recovery_custodian_acceptances acceptance
    WHERE acceptance.id = organization_recovery_valid_acceptance_id(
      custodian.policy_id, custodian.canonical_identity_id
    )
  ) current_acceptance ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM canonical_human_identity_subjects subject_row
      INNER JOIN canonical_human_identities identity_row
        ON identity_row.id = subject_row.identity_id
      WHERE membership.subject_id = 'user:' || subject_row.auth_user_id
        AND subject_row.identity_id = custodian.canonical_identity_id
        AND subject_row.status = 'active'
        AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
        AND membership.status = 'active' AND membership.role <> 'owner'
    ) AS eligible
  ) current_eligibility ON true
  WHERE custodian.policy_id = policy_row.id;
  policy_state := CASE
    WHEN NOT head_row.enabled THEN 'disabled'
    WHEN valid_acceptances = 3 THEN 'active'
    WHEN head_row.activated_at IS NULL THEN 'pending_acceptance'
    ELSE 'degraded'
  END;
  SELECT * INTO operation_row FROM organization_recovery_operations operation
  WHERE operation.account_id = p_account_id
  ORDER BY operation.created_at DESC, operation.id DESC LIMIT 1;
  IF FOUND THEN
    valid_approvals := organization_recovery_valid_approval_count(operation_row.id);
    approvals_rows := organization_recovery_valid_approvals_json(operation_row.id);
    SELECT auth_user.name, auth_user.email INTO target_name, target_email
    FROM auth_users auth_user WHERE auth_user.id = operation_row.target_auth_user_id;
    SELECT EXISTS (
      SELECT 1
      FROM organization_memberships membership
      INNER JOIN canonical_human_identity_subjects subject_row
        ON membership.subject_id = 'user:' || subject_row.auth_user_id
      INNER JOIN canonical_human_identities identity_row
        ON identity_row.id = subject_row.identity_id
      WHERE membership.id = operation_row.target_membership_id
        AND membership.account_id = operation_row.account_id
        AND membership.status = 'active' AND membership.role <> 'owner'
        AND membership.authorization_revision = operation_row.target_membership_authorization_revision
        AND subject_row.auth_user_id = operation_row.target_auth_user_id
        AND subject_row.identity_id = operation_row.target_identity_id
        AND subject_row.status = 'active'
        AND subject_row.revision = operation_row.target_subject_revision
        AND identity_row.status = 'active' AND identity_row.recovery_state = 'ready'
        AND identity_row.identity_revision = operation_row.target_identity_revision
        AND identity_row.auth_revision = operation_row.target_auth_revision
    ) INTO target_current;
    operation_state := CASE
      WHEN operation_row.state IN ('executed', 'cancelled', 'superseded') THEN operation_row.state
      WHEN operation_row.expires_at <= now_value THEN 'expired'
      WHEN operation_row.policy_id <> head_row.current_policy_id OR NOT head_row.enabled
        THEN 'superseded'
      WHEN policy_state <> 'active' OR valid_approvals < 2 OR NOT target_current THEN 'collecting'
      ELSE 'cooling'
    END;
    IF operation_row.notification_batch_id IS NOT NULL THEN
      SELECT pg_catalog.count(*)::integer,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.string_agg(
            outbox.id::text || ':' || outbox.payload_digest, ',' ORDER BY outbox.id
          ), 'UTF8'
        )), 'hex')
      INTO actual_notification_count, actual_notification_digest
      FROM organization_recovery_notification_outbox outbox
      WHERE outbox.operation_id = operation_row.id
        AND outbox.batch_id = operation_row.notification_batch_id;
      notification_journaled := actual_notification_count > 0
        AND actual_notification_count IS NOT DISTINCT FROM operation_row.notification_count
        AND actual_notification_digest IS NOT DISTINCT FROM operation_row.notification_digest;
    END IF;
  END IF;
  IF actor_identity.id IS NOT NULL THEN
    actor_is_custodian := EXISTS (
      SELECT 1 FROM organization_recovery_custodians custodian
      WHERE custodian.policy_id = policy_row.id
        AND custodian.membership_id = actor_membership.id
        AND custodian.canonical_identity_id = actor_identity.id
    );
    actor_has_acceptance := actor_is_custodian AND
      organization_recovery_valid_acceptance_id(policy_row.id, actor_identity.id) IS NOT NULL;
    actor_has_approval := operation_row.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(approvals_rows) approval
      WHERE approval ->> 'membershipId' = actor_membership.id::text
    );
  END IF;
  IF actor_membership.role <> 'owner' AND NOT actor_is_custodian THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;

  capability_accept := has_recent_reauthentication AND head_row.enabled AND actor_is_custodian
    AND actor_membership.role <> 'owner' AND actor_identity.id IS NOT NULL
    AND NOT actor_has_acceptance;
  capability_disable := has_recent_reauthentication
    AND actor_membership.role = 'owner' AND actor_identity.id IS NOT NULL
    AND head_row.enabled;
  capability_start := has_recent_reauthentication AND head_row.enabled AND policy_state = 'active'
    AND actor_is_custodian AND actor_has_acceptance
    AND actor_membership.role <> 'owner' AND actor_identity.id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM organization_recovery_operations live_operation
      WHERE live_operation.account_id = p_account_id
        AND live_operation.state IN ('collecting', 'cooling')
        AND live_operation.expires_at > now_value
    );
  capability_approve := has_recent_reauthentication AND operation_row.id IS NOT NULL
    AND operation_row.state IN ('collecting', 'cooling')
    AND operation_row.expires_at > now_value
    AND head_row.enabled AND policy_state = 'active' AND valid_acceptances = 3
    AND operation_row.policy_id = head_row.current_policy_id
    AND actor_is_custodian AND actor_has_acceptance
    AND actor_membership.role <> 'owner' AND actor_identity.id IS NOT NULL
    AND operation_row.target_identity_id <> actor_identity.id
    AND NOT actor_has_approval;
  capability_cancel := has_recent_reauthentication AND operation_row.id IS NOT NULL
    AND operation_row.state IN ('collecting', 'cooling')
    AND operation_row.expires_at > now_value
    AND head_row.enabled AND operation_row.policy_id = head_row.current_policy_id
    AND actor_membership.role = 'owner' AND actor_identity.id IS NOT NULL;
  capability_execute := has_recent_reauthentication AND operation_row.id IS NOT NULL
    AND operation_row.state = 'cooling' AND operation_state = 'cooling'
    AND operation_row.executable_at <= now_value AND operation_row.expires_at > now_value
    AND policy_state = 'active' AND valid_acceptances = 3 AND valid_approvals >= 2
    AND target_current AND notification_journaled
    AND actor_is_custodian AND actor_has_acceptance AND actor_has_approval
    AND actor_membership.role <> 'owner' AND actor_identity.id IS NOT NULL
    AND operation_row.target_identity_id <> actor_identity.id;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RETURN pg_catalog.jsonb_build_object(
    'organizationId', p_account_id::text,
    'availability', CASE
      WHEN policy_state = 'active' AND actor_identity.id IS NOT NULL
      THEN 'available' ELSE 'recovery_unavailable' END,
    'unavailableReason', CASE
      WHEN actor_identity.id IS NULL THEN 'identity_unavailable'
      WHEN policy_state = 'pending_acceptance' THEN 'pending_acceptance'
      WHEN policy_state = 'degraded' THEN 'degraded'
      WHEN policy_state = 'disabled' THEN 'disabled'
      ELSE NULL END,
    'recentReauthenticationAt', p_recent_reauthentication_at,
    'eligibleMembers', eligible_member_rows,
    'policy', pg_catalog.jsonb_build_object(
      'id', policy_row.id::text, 'organizationId', p_account_id::text,
      'revision', head_row.revision, 'state', policy_state,
      'custodians', custodian_rows
      , 'createdAt', policy_row.configured_at, 'updatedAt', head_row.updated_at
    ),
    'operation', CASE WHEN operation_row.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'id', operation_row.id::text, 'organizationId', p_account_id::text,
      'policyId', operation_row.policy_id::text,
      'policyRevision', operation_row.policy_revision,
      'revision', operation_row.revision,
      'state', operation_state,
      'target', pg_catalog.jsonb_build_object(
        'membershipId', operation_row.target_membership_id::text,
        'name', target_name, 'email', target_email
      ),
      'approvalCount', valid_approvals,
      'approvals', approvals_rows,
      'quorumAt', operation_row.quorum_at,
      'executableAt', operation_row.executable_at,
      'expiresAt', operation_row.expires_at,
      'notificationJournaled', notification_journaled,
      'executedAt', operation_row.executed_at,
      'cancelledAt', operation_row.cancelled_at,
      'createdAt', operation_row.created_at,
      'updatedAt', operation_row.updated_at
    ) END,
    'capabilities', pg_catalog.jsonb_build_object(
      'configure', capability_configure, 'accept', capability_accept,
      'disable', capability_disable, 'start', capability_start,
      'approve', capability_approve, 'cancel', capability_cancel,
      'execute', capability_execute
    )
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RAISE;
END
$body$;

CREATE OR REPLACE FUNCTION get_organization_recovery_overview(
  p_account_id uuid, p_actor_subject text, p_fence jsonb,
  p_auth_session_id text, p_auth_user_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $body$
DECLARE
  recent_proof jsonb;
  previous_recovery_marker text := pg_catalog.current_setting(
    'opengeni.organization_recovery_lifecycle', true
  );
  previous_organization_marker text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
BEGIN
  IF p_account_id IS NULL OR p_actor_subject IS NULL
    OR p_actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
  THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle', 'active', true);
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  IF NOT EXISTS (
    SELECT 1 FROM organization_memberships membership
    WHERE membership.account_id = p_account_id AND membership.subject_id = p_actor_subject
      AND membership.status = 'active'
  ) THEN
    RAISE EXCEPTION 'organization recovery authority is invalid' USING ERRCODE = '42501';
  END IF;
  recent_proof := organization_recovery_resolve_recent_reauth(
    p_fence, p_actor_subject, p_auth_session_id, p_auth_user_id
  );
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RETURN organization_recovery_overview_json(
    p_account_id, p_actor_subject,
    CASE WHEN recent_proof IS NULL THEN NULL
      ELSE (recent_proof ->> 'reauthenticatedAt')::timestamptz END
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config('opengeni.organization_recovery_lifecycle',
    CASE WHEN previous_recovery_marker IS NULL THEN '' ELSE previous_recovery_marker END, true);
  PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_organization_marker IS NULL THEN '' ELSE previous_organization_marker END, true);
  RAISE;
END
$body$;

DO $organization_recovery_security$
DECLARE
  data_schema text := current_schema();
  signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'organization_recovery_command(jsonb)',
    'organization_recovery_lock_policy_evidence(uuid,uuid)',
    'get_organization_recovery_overview(uuid,text,jsonb,text,text)',
    'organization_recovery_overview_json(uuid,text,timestamptz)',
    'organization_recovery_valid_acceptance_id(uuid,uuid)',
    'organization_recovery_valid_approval_count(uuid)',
    'organization_recovery_valid_approvals_json(uuid)',
    'organization_recovery_resolve_recent_reauth(jsonb,text,text,text)',
    'organization_recovery_assert_recent_reauth(jsonb,text,text,text)',
    'organization_recovery_exactly_three_custodians()',
    'prepare_organization_recovery_notifications(text,text,integer,integer)',
    'settle_organization_recovery_notification(uuid,uuid,text,text,text,text)',
    'reconcile_organization_recovery_notification(uuid,uuid,text,text,text)'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp',
      data_schema, signature, data_schema
    );
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'reject_workspace_account_id_change()',
    'organization_recovery_append_only()'
  ] LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp',
      data_schema, signature, data_schema
    );
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature);
  END LOOP;
  IF pg_catalog.to_regrole('opengeni_app') IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.organization_recovery_command(jsonb) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_organization_recovery_overview(uuid,text,jsonb,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$organization_recovery_security$;

COMMENT ON TABLE "organization_recovery_policies" IS
  'Immutable revisioned three-custodian organization recovery policy evidence.';
COMMENT ON TABLE "organization_recovery_operations" IS
  'CAS-governed quorum recovery operations with fixed seven-day cooldown and promotion-only execution.';
COMMENT ON TABLE "organization_recovery_command_receipts" IS
  'Append-only exact-command recovery receipts; request actor-lease ids are excluded from semantic digests.';
COMMENT ON TABLE "organization_recovery_notification_outbox" IS
  'Immutable provider-neutral notification work; external I/O occurs only after provider_started is journaled.';
COMMENT ON TABLE "organization_recovery_notification_attempts" IS
  'Append-only bounded delivery claims, terminal outcomes, stale-claim evidence, and explicit ambiguous-outcome reconciliation.';
COMMENT ON FUNCTION reject_workspace_account_id_change() IS
  'Rejects every distinct workspace organization-owner mutation, including direct migration-owner SQL.';
