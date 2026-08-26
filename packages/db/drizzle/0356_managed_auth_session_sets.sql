-- deployment-mode: rolling
-- Hash-only browser session-set authority and provider-neutral login slots.
-- Broker activation is deployment-owned and remains off in repository defaults.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "auth_sessions"
  ADD COLUMN "login_binding_id" uuid,
  ADD COLUMN "login_binding_revision" bigint;

-- The migration principal is a non-superuser table owner. Open an owner-only
-- visibility window so the exact-binding preflight cannot pass vacuously under
-- FORCE RLS; ordinary runtime roles remain policy-bound throughout.
ALTER TABLE "canonical_human_login_bindings" NO FORCE ROW LEVEL SECURITY;
DO $managed_auth_session_binding_backfill$
DECLARE
  previous_canonical_marker text := pg_catalog.current_setting(
    'opengeni.canonical_human_identity_lifecycle', true
  );
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.canonical_human_identity_lifecycle', 'active', true
  );
  IF EXISTS (
    SELECT 1
    FROM auth_sessions auth_session
    WHERE (
      SELECT count(*)
      FROM auth_identities auth_identity
      INNER JOIN canonical_human_login_bindings binding
        ON binding.identity_id = auth_session.identity_id
       AND binding.provider_id = lower(auth_identity.provider_id)
       AND binding.provider_account_id = auth_identity.account_id
       AND binding.status IN ('active', 'recovery_pending')
      WHERE auth_identity.user_id = auth_session.user_id
        AND lower(auth_identity.provider_id) = 'credential'
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'every live auth session must prove exactly one active login binding'
      USING ERRCODE = '55000';
  END IF;

  WITH exact_bindings AS (
    SELECT auth_session.id AS auth_session_id,
      min(binding.id::text)::uuid AS login_binding_id,
      min(binding.revision) AS login_binding_revision
    FROM auth_sessions auth_session
    INNER JOIN auth_identities auth_identity
      ON auth_identity.user_id = auth_session.user_id
     AND lower(auth_identity.provider_id) = 'credential'
    INNER JOIN canonical_human_login_bindings binding
      ON binding.identity_id = auth_session.identity_id
     AND binding.provider_id = lower(auth_identity.provider_id)
     AND binding.provider_account_id = auth_identity.account_id
     AND binding.status IN ('active', 'recovery_pending')
    GROUP BY auth_session.id
    HAVING count(*) = 1
  )
  UPDATE auth_sessions auth_session
  SET login_binding_id = exact_binding.id,
      login_binding_revision = exact_binding.revision
  FROM (
    SELECT auth_session_id, login_binding_id AS id, login_binding_revision AS revision
    FROM exact_bindings
  ) exact_binding
  WHERE auth_session.id = exact_binding.auth_session_id;
  PERFORM pg_catalog.set_config(
    'opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
    true
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM pg_catalog.set_config(
    'opengeni.canonical_human_identity_lifecycle',
    CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
    true
  );
  RAISE;
END
$managed_auth_session_binding_backfill$;
ALTER TABLE "canonical_human_login_bindings" FORCE ROW LEVEL SECURITY;

DO $managed_auth_session_exact_binding_stamp_install$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.get_canonical_human_exact_login_binding(
      p_auth_user_id text,
      p_provider_id text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      binding_count integer;
      result jsonb;
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_auth_user_id IS NULL OR pg_catalog.btrim(p_auth_user_id) = ''
        OR p_provider_id IS NULL OR pg_catalog.btrim(p_provider_id) = ''
      THEN
        RAISE EXCEPTION 'canonical human exact login binding input is invalid'
          USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );
      SELECT pg_catalog.count(*)::integer,
        CASE WHEN pg_catalog.count(*) = 1 THEN pg_catalog.jsonb_build_object(
          'id', pg_catalog.min(binding.id::text),
          'identityId', pg_catalog.min(binding.identity_id::text),
          'revision', pg_catalog.min(binding.revision)::text,
          'status', pg_catalog.min(binding.status)
        ) ELSE NULL END
      INTO binding_count, result
      FROM auth_identities auth_identity
      INNER JOIN canonical_human_identity_subjects subject_row
        ON subject_row.auth_user_id = auth_identity.user_id
       AND subject_row.status = 'active'
      INNER JOIN canonical_human_login_bindings binding
        ON binding.identity_id = subject_row.identity_id
       AND binding.provider_id = lower(auth_identity.provider_id)
       AND binding.provider_account_id = auth_identity.account_id
      WHERE auth_identity.user_id = p_auth_user_id
        AND lower(auth_identity.provider_id) = lower(p_provider_id);
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
        true
      );
      RETURN CASE WHEN binding_count = 1 THEN result ELSE NULL END;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_exact_binding_stamp()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      exact_binding_id uuid;
      exact_binding_revision bigint;
      binding_count integer;
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );
      IF NEW.login_binding_id IS NULL THEN
        SELECT min(binding.id::text)::uuid, min(binding.revision), count(*)::integer
        INTO exact_binding_id, exact_binding_revision, binding_count
        FROM auth_identities auth_identity
        INNER JOIN canonical_human_login_bindings binding
          ON binding.identity_id = NEW.identity_id
         AND binding.provider_id = lower(auth_identity.provider_id)
         AND binding.provider_account_id = auth_identity.account_id
         AND binding.status IN ('active', 'recovery_pending')
        WHERE auth_identity.user_id = NEW.user_id
          AND lower(auth_identity.provider_id) = 'credential';
      ELSE
        SELECT min(binding.id::text)::uuid, min(binding.revision), count(*)::integer
        INTO exact_binding_id, exact_binding_revision, binding_count
        FROM auth_identities auth_identity
        INNER JOIN canonical_human_login_bindings binding
          ON binding.id = NEW.login_binding_id
         AND binding.identity_id = NEW.identity_id
         AND binding.provider_id = lower(auth_identity.provider_id)
         AND binding.provider_account_id = auth_identity.account_id
         AND binding.status IN ('active', 'recovery_pending')
        WHERE auth_identity.user_id = NEW.user_id;
      END IF;
      IF binding_count <> 1 OR exact_binding_id IS NULL OR exact_binding_revision IS NULL THEN
        RAISE EXCEPTION 'auth session must prove exactly one login binding'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.login_binding_id IS NOT NULL AND NEW.login_binding_id <> exact_binding_id THEN
        RAISE EXCEPTION 'auth session login binding does not match the authenticated credential'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.login_binding_revision IS NOT NULL
        AND NEW.login_binding_revision <> exact_binding_revision
      THEN
        RAISE EXCEPTION 'auth session login binding revision is stale' USING ERRCODE = '42501';
      END IF;
      NEW.login_binding_id := exact_binding_id;
      NEW.login_binding_revision := exact_binding_revision;
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
        true
      );
      RETURN NEW;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'CREATE TRIGGER managed_auth_session_exact_binding_stamp BEFORE INSERT ON %I.auth_sessions '
      || 'FOR EACH ROW EXECUTE FUNCTION %I.managed_auth_session_exact_binding_stamp()',
    data_schema, data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.managed_auth_session_exact_binding_stamp() FROM PUBLIC',
    data_schema
  );
END
$managed_auth_session_exact_binding_stamp_install$;

ALTER TABLE "auth_sessions"
  ALTER COLUMN "login_binding_id" SET NOT NULL,
  ALTER COLUMN "login_binding_revision" SET NOT NULL,
  ADD CONSTRAINT "auth_sessions_login_binding_fk"
    FOREIGN KEY ("login_binding_id") REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "auth_sessions_login_binding_revision_check" CHECK ("login_binding_revision" > 0);
CREATE INDEX "auth_sessions_login_binding_revision_idx"
  ON "auth_sessions" ("login_binding_id", "login_binding_revision");

CREATE TABLE "managed_auth_browser_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authority_hash" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "idle_expires_at" timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  "absolute_expires_at" timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  "revoked_at" timestamptz,
  CONSTRAINT "managed_auth_browser_installations_hash_check" CHECK (
    "authority_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "managed_auth_browser_installations_expiry_check" CHECK (
    "idle_expires_at" > "created_at"
    AND "idle_expires_at" <= "absolute_expires_at"
    AND "absolute_expires_at" <= "created_at" + interval '180 days'
  )
);

CREATE TABLE "managed_auth_session_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "installation_id" uuid NOT NULL UNIQUE
    REFERENCES "managed_auth_browser_installations"("id") ON DELETE RESTRICT,
  "authority_hash" text NOT NULL UNIQUE,
  "csrf_hash" text NOT NULL,
  "generation" bigint NOT NULL DEFAULT 1,
  "actor_epoch" bigint NOT NULL DEFAULT 1,
  "selected_slot_id" uuid,
  "state" text NOT NULL DEFAULT 'ready',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "idle_expires_at" timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  "absolute_expires_at" timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  "revoked_at" timestamptz,
  CONSTRAINT "managed_auth_session_sets_hash_check" CHECK (
    "authority_hash" ~ '^[0-9a-f]{64}$' AND "csrf_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "managed_auth_session_sets_generation_check" CHECK (
    "generation" > 0 AND "actor_epoch" > 0
  ),
  CONSTRAINT "managed_auth_session_sets_state_check" CHECK (
    "state" IN ('ready', 'actor_change_required')
  ),
  CONSTRAINT "managed_auth_session_sets_expiry_check" CHECK (
    "idle_expires_at" > "created_at"
    AND "idle_expires_at" <= "absolute_expires_at"
    AND "absolute_expires_at" <= "created_at" + interval '180 days'
  )
);

CREATE TABLE "managed_auth_login_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_set_id" uuid NOT NULL
    REFERENCES "managed_auth_session_sets"("id") ON DELETE CASCADE,
  "auth_session_id" text REFERENCES "auth_sessions"("id") ON DELETE SET NULL,
  "auth_user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "identity_id" uuid NOT NULL
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "login_binding_id" uuid NOT NULL
    REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  "identity_revision" bigint NOT NULL,
  "auth_revision" bigint NOT NULL,
  "login_binding_revision" bigint NOT NULL,
  "display_name" text NOT NULL,
  "verified_email" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "managed_auth_login_slots_revision_check" CHECK (
    "identity_revision" > 0 AND "auth_revision" > 0 AND "login_binding_revision" > 0
  ),
  CONSTRAINT "managed_auth_login_slots_display_check" CHECK (
    length(btrim("display_name")) BETWEEN 1 AND 256
    AND length(btrim("verified_email")) BETWEEN 3 AND 320
  ),
  CONSTRAINT "managed_auth_login_slots_status_check" CHECK (
    "status" IN ('active', 'reauth_required', 'revoked')
  ),
  CONSTRAINT "managed_auth_login_slots_revocation_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
  )
);
CREATE UNIQUE INDEX "managed_auth_login_slots_live_binding_idx"
  ON "managed_auth_login_slots" ("session_set_id", "login_binding_id")
  WHERE "status" <> 'revoked';
CREATE UNIQUE INDEX "managed_auth_login_slots_live_session_idx"
  ON "managed_auth_login_slots" ("auth_session_id")
  WHERE "auth_session_id" IS NOT NULL AND "status" <> 'revoked';
CREATE INDEX "managed_auth_login_slots_set_status_idx"
  ON "managed_auth_login_slots" ("session_set_id", "status", "created_at", "id");
ALTER TABLE "managed_auth_login_slots"
  ADD CONSTRAINT "managed_auth_login_slots_id_set_unique" UNIQUE ("id", "session_set_id");

ALTER TABLE "managed_auth_session_sets"
  ADD CONSTRAINT "managed_auth_session_sets_selected_slot_fk"
  FOREIGN KEY ("selected_slot_id", "id")
  REFERENCES "managed_auth_login_slots"("id", "session_set_id") ON DELETE RESTRICT;

CREATE TABLE "managed_auth_login_return_intents" (
  "id" uuid PRIMARY KEY,
  "session_set_id" uuid NOT NULL
    REFERENCES "managed_auth_session_sets"("id") ON DELETE CASCADE,
  "path" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "managed_auth_login_return_intents_path_check" CHECK (
    octet_length("path") BETWEEN 1 AND 2048
    AND left("path", 1) = '/'
    AND left("path", 2) <> '//'
    AND position('?' in "path") = 0
    AND position('#' in "path") = 0
    AND position(E'\\' in "path") = 0
    AND "path" !~ '[[:cntrl:]]'
    AND "path" ~* '^/(sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(/sessions(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?)?)$'
  ),
  CONSTRAINT "managed_auth_login_return_intents_expiry_check" CHECK (
    "expires_at" > "created_at"
  )
);

CREATE TABLE "managed_auth_login_transactions" (
  "id" uuid PRIMARY KEY,
  "session_set_id" uuid NOT NULL
    REFERENCES "managed_auth_session_sets"("id") ON DELETE CASCADE,
  "secret_hash" text NOT NULL,
  "kind" text NOT NULL,
  "target_slot_id" uuid REFERENCES "managed_auth_login_slots"("id") ON DELETE RESTRICT,
  "expected_identity_id" uuid
    REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "expected_login_binding_id" uuid
    REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  "expected_identity_revision" bigint,
  "expected_auth_revision" bigint,
  "expected_login_binding_revision" bigint,
  "expected_generation" bigint NOT NULL,
  "return_intent_id" uuid
    REFERENCES "managed_auth_login_return_intents"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "managed_auth_login_transactions_hash_check" CHECK (
    "secret_hash" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "managed_auth_login_transactions_kind_check" CHECK (
    "kind" IN ('add', 'reauth')
  ),
  CONSTRAINT "managed_auth_login_transactions_status_check" CHECK (
    "status" IN ('pending', 'consumed', 'cancelled')
  ),
  CONSTRAINT "managed_auth_login_transactions_generation_check" CHECK (
    "expected_generation" > 0
    AND ("expected_identity_revision" IS NULL OR "expected_identity_revision" > 0)
    AND ("expected_auth_revision" IS NULL OR "expected_auth_revision" > 0)
    AND ("expected_login_binding_revision" IS NULL OR "expected_login_binding_revision" > 0)
  ),
  CONSTRAINT "managed_auth_login_transactions_target_check" CHECK (
    ("kind" = 'add' AND "target_slot_id" IS NULL
      AND "expected_identity_id" IS NULL AND "expected_login_binding_id" IS NULL
      AND "expected_identity_revision" IS NULL AND "expected_auth_revision" IS NULL
      AND "expected_login_binding_revision" IS NULL)
    OR ("kind" = 'reauth' AND "target_slot_id" IS NOT NULL
      AND "expected_identity_id" IS NOT NULL AND "expected_login_binding_id" IS NOT NULL
      AND "expected_identity_revision" IS NOT NULL AND "expected_auth_revision" IS NOT NULL
      AND "expected_login_binding_revision" IS NOT NULL)
  ),
  CONSTRAINT "managed_auth_login_transactions_expiry_check" CHECK (
    "expires_at" > "created_at"
  )
);
CREATE INDEX "managed_auth_login_transactions_set_status_idx"
  ON "managed_auth_login_transactions" ("session_set_id", "status", "expires_at");

ALTER TABLE "auth_sessions"
  ADD COLUMN "managed_auth_login_transaction_id" uuid
  REFERENCES "managed_auth_login_transactions"("id") ON DELETE SET NULL;
CREATE INDEX "auth_sessions_managed_auth_login_transaction_idx"
  ON "auth_sessions" ("managed_auth_login_transaction_id", "created_at")
  WHERE "managed_auth_login_transaction_id" IS NOT NULL;

CREATE TABLE "managed_auth_session_set_operations" (
  "operation_id" uuid PRIMARY KEY,
  "session_set_id" uuid NOT NULL
    REFERENCES "managed_auth_session_sets"("id") ON DELETE RESTRICT,
  "operation_type" text NOT NULL,
  "request_digest" text NOT NULL,
  "expected_generation" bigint NOT NULL,
  "result_generation" bigint NOT NULL,
  "result_actor_epoch" bigint NOT NULL,
  "target_slot_id" uuid,
  "replacement_slot_id" uuid,
  "outcome" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "managed_auth_session_set_operations_type_check" CHECK (
    "operation_type" IN (
      'bootstrap', 'begin_add', 'begin_reauth', 'complete_add', 'complete_reauth',
      'cancel_transaction', 'select', 'logout_one', 'logout_all'
    )
  ),
  CONSTRAINT "managed_auth_session_set_operations_digest_check" CHECK (
    "request_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "managed_auth_session_set_operations_generation_check" CHECK (
    "expected_generation" > 0 AND "result_generation" > 0 AND "result_actor_epoch" > 0
  ),
  CONSTRAINT "managed_auth_session_set_operations_outcome_check" CHECK (
    "outcome" IN ('applied', 'converged')
  ),
  CONSTRAINT "managed_auth_session_set_operations_result_check" CHECK (
    pg_catalog.jsonb_typeof("result") = 'object'
    AND octet_length("result"::text) <= 16384
  )
);
CREATE INDEX "managed_auth_session_set_operations_set_created_idx"
  ON "managed_auth_session_set_operations" ("session_set_id", "created_at", "operation_id");

CREATE TABLE "managed_auth_actor_mutation_leases" (
  "session_set_id" uuid NOT NULL
    REFERENCES "managed_auth_session_sets"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL,
  "actor_epoch" bigint NOT NULL,
  "acquired_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("session_set_id", "request_id"),
  CONSTRAINT "managed_auth_actor_mutation_leases_epoch_check" CHECK ("actor_epoch" > 0),
  CONSTRAINT "managed_auth_actor_mutation_leases_expiry_check" CHECK (
    "expires_at" > "acquired_at"
    AND "expires_at" <= "acquired_at" + interval '15 minutes'
  )
);
CREATE INDEX "managed_auth_actor_mutation_leases_expiry_idx"
  ON "managed_auth_actor_mutation_leases" ("expires_at", "session_set_id");

ALTER TABLE "managed_auth_browser_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_browser_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_session_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_session_sets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_slots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_slots" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_return_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_return_intents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_login_transactions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_session_set_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_session_set_operations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_actor_mutation_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "managed_auth_actor_mutation_leases" FORCE ROW LEVEL SECURITY;

CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_session_sets"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_browser_installations"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_login_slots"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_login_return_intents"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_login_transactions"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_session_set_operations"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');
CREATE POLICY managed_auth_session_set_lifecycle ON "managed_auth_actor_mutation_leases"
  USING (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.managed_auth_session_set_lifecycle', true) = 'active');

CREATE OR REPLACE FUNCTION managed_auth_session_set_operations_append_only()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'managed auth session-set operations are append-only' USING ERRCODE = '42501';
END
$body$;
CREATE TRIGGER managed_auth_session_set_operations_append_only
  BEFORE UPDATE OR DELETE ON "managed_auth_session_set_operations"
  FOR EACH ROW EXECUTE FUNCTION managed_auth_session_set_operations_append_only();

DO $managed_auth_session_set_routines$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_authority_state(
      p_authority_hash text
    ) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      authority_state text;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash IS NULL OR p_authority_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'managed auth session-set authority is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT CASE
        WHEN session_set.id IS NULL AND installation.id IS NULL THEN 'absent'
        WHEN session_set.revoked_at IS NULL AND installation.revoked_at IS NULL
          AND session_set.idle_expires_at > pg_catalog.clock_timestamp()
          AND session_set.absolute_expires_at > pg_catalog.clock_timestamp()
          AND installation.idle_expires_at > pg_catalog.clock_timestamp()
          AND installation.absolute_expires_at > pg_catalog.clock_timestamp()
        THEN 'active' ELSE 'retired' END
      INTO authority_state
      FROM (SELECT p_authority_hash AS authority_hash) input
      LEFT JOIN managed_auth_browser_installations installation
        ON installation.authority_hash = input.authority_hash
      LEFT JOIN managed_auth_session_sets session_set
        ON session_set.authority_hash = input.authority_hash;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN coalesce(authority_state, 'absent');
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_snapshot(
      p_authority_hash text,
      p_mode text DEFAULT 'legacy',
      p_include_internal boolean DEFAULT false,
      p_allow_recovery boolean DEFAULT false,
      p_read_only boolean DEFAULT false
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      changed_count integer := 0;
      selected_lost boolean := false;
      result jsonb;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_authority_hash IS NULL OR p_authority_hash !~ '^[0-9a-f]{64}$'
        OR p_mode NOT IN ('legacy', 'dual', 'broker')
      THEN
        RAISE EXCEPTION 'managed auth session-set authority is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      SELECT session_set.* INTO set_row
      FROM managed_auth_session_sets session_set
      INNER JOIN managed_auth_browser_installations installation
        ON installation.id = session_set.installation_id
      WHERE session_set.authority_hash = p_authority_hash
      FOR UPDATE OF session_set, installation;
      IF NOT FOUND THEN
        PERFORM pg_catalog.set_config(
          'opengeni.managed_auth_session_set_lifecycle',
          CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
        );
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN NULL;
      END IF;
      IF set_row.revoked_at IS NOT NULL OR EXISTS (
        SELECT 1 FROM managed_auth_browser_installations installation
        WHERE installation.id = set_row.installation_id AND installation.revoked_at IS NOT NULL
      ) THEN
        PERFORM pg_catalog.set_config(
          'opengeni.managed_auth_session_set_lifecycle',
          CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
        );
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN NULL;
      END IF;
      IF set_row.idle_expires_at <= pg_catalog.clock_timestamp()
        OR set_row.absolute_expires_at <= pg_catalog.clock_timestamp()
        OR EXISTS (
          SELECT 1 FROM managed_auth_browser_installations installation
          WHERE installation.id = set_row.installation_id
            AND (installation.idle_expires_at <= pg_catalog.clock_timestamp()
              OR installation.absolute_expires_at <= pg_catalog.clock_timestamp())
        )
      THEN
        IF p_read_only THEN
          PERFORM pg_catalog.set_config(
            'opengeni.managed_auth_session_set_lifecycle',
            CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
          );
          PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
          RETURN NULL;
        END IF;
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
        ) THEN
          RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
        END IF;
        DELETE FROM auth_sessions auth_session USING managed_auth_login_slots slot
        WHERE slot.session_set_id = set_row.id AND slot.status <> 'revoked'
          AND auth_session.id = slot.auth_session_id;
        UPDATE managed_auth_login_slots SET status = 'revoked', auth_session_id = NULL,
          revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
        WHERE session_set_id = set_row.id AND status <> 'revoked';
        UPDATE managed_auth_session_sets SET revoked_at = pg_catalog.clock_timestamp(),
          state = 'actor_change_required', updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id;
        UPDATE managed_auth_browser_installations SET revoked_at = pg_catalog.clock_timestamp(),
          last_seen_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.installation_id;
        PERFORM pg_catalog.set_config(
          'opengeni.managed_auth_session_set_lifecycle',
          CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
        );
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN NULL;
      END IF;
      IF NOT p_read_only THEN
        UPDATE managed_auth_browser_installations installation SET
          last_seen_at = pg_catalog.clock_timestamp(),
          idle_expires_at = least(pg_catalog.clock_timestamp() + interval '30 days', installation.absolute_expires_at)
        WHERE installation.id = set_row.installation_id;
        UPDATE managed_auth_session_sets session_set SET
          idle_expires_at = least(pg_catalog.clock_timestamp() + interval '30 days', session_set.absolute_expires_at),
          updated_at = pg_catalog.clock_timestamp()
        WHERE session_set.id = set_row.id RETURNING * INTO set_row;
      END IF;

      IF NOT p_read_only AND EXISTS (
        SELECT 1
        FROM managed_auth_login_slots slot
        LEFT JOIN auth_sessions auth_session ON auth_session.id = slot.auth_session_id
        LEFT JOIN canonical_human_identities identity_row ON identity_row.id = slot.identity_id
        LEFT JOIN canonical_human_login_bindings binding ON binding.id = slot.login_binding_id
        LEFT JOIN canonical_human_identity_subjects subject_row
          ON subject_row.auth_user_id = slot.auth_user_id
         AND subject_row.identity_id = slot.identity_id
        WHERE slot.id = set_row.selected_slot_id AND slot.status = 'active'
          AND NOT (
            identity_row.status = 'recovery_required'
            AND binding.id = slot.login_binding_id
            AND binding.identity_id = slot.identity_id
            AND binding.status = 'recovery_pending'
            AND subject_row.status = 'active'
          )
          AND NOT (
            auth_session.id IS NOT NULL
            AND auth_session.user_id = slot.auth_user_id
            AND auth_session.expires_at > pg_catalog.clock_timestamp()
            AND auth_session.identity_id = slot.identity_id
            AND auth_session.identity_revision = slot.identity_revision
            AND auth_session.auth_revision = slot.auth_revision
            AND auth_session.login_binding_id = slot.login_binding_id
            AND auth_session.login_binding_revision = slot.login_binding_revision
            AND identity_row.status = 'active'
            AND identity_row.identity_revision = slot.identity_revision
            AND identity_row.auth_revision = slot.auth_revision
            AND binding.identity_id = slot.identity_id
            AND binding.status = 'active'
            AND binding.revision = slot.login_binding_revision
            AND subject_row.status = 'active'
          )
      ) THEN
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
        ) THEN
          RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
        END IF;
      END IF;

      IF NOT p_read_only THEN
      WITH invalid AS (
        SELECT slot.id, slot.auth_session_id, slot.id = set_row.selected_slot_id AS was_selected
        FROM managed_auth_login_slots slot
        LEFT JOIN auth_sessions auth_session ON auth_session.id = slot.auth_session_id
        LEFT JOIN canonical_human_identities identity_row ON identity_row.id = slot.identity_id
        LEFT JOIN canonical_human_login_bindings binding ON binding.id = slot.login_binding_id
        LEFT JOIN canonical_human_identity_subjects subject_row
          ON subject_row.auth_user_id = slot.auth_user_id
         AND subject_row.identity_id = slot.identity_id
        WHERE slot.session_set_id = set_row.id AND slot.status = 'active'
          AND NOT (
            slot.id = set_row.selected_slot_id
            AND identity_row.status = 'recovery_required'
            AND binding.id = slot.login_binding_id
            AND binding.identity_id = slot.identity_id
            AND binding.status = 'recovery_pending'
            AND subject_row.status = 'active'
          )
          AND NOT (
            auth_session.id IS NOT NULL
            AND auth_session.user_id = slot.auth_user_id
            AND auth_session.expires_at > pg_catalog.clock_timestamp()
            AND auth_session.identity_id = slot.identity_id
            AND auth_session.identity_revision = slot.identity_revision
            AND auth_session.auth_revision = slot.auth_revision
            AND auth_session.login_binding_id = slot.login_binding_id
            AND auth_session.login_binding_revision = slot.login_binding_revision
            AND (
              identity_row.status = 'active'
              OR (
                p_allow_recovery
                AND slot.id = set_row.selected_slot_id
                AND identity_row.status = 'recovery_required'
              )
            )
            AND identity_row.identity_revision = slot.identity_revision
            AND identity_row.auth_revision = slot.auth_revision
            AND binding.identity_id = slot.identity_id
            AND (
              binding.status = 'active'
              OR (
                p_allow_recovery
                AND slot.id = set_row.selected_slot_id
                AND identity_row.status = 'recovery_required'
                AND binding.status = 'recovery_pending'
              )
            )
            AND binding.revision = slot.login_binding_revision
            AND subject_row.status = 'active'
          )
      ), stale AS (
        UPDATE managed_auth_login_slots slot
        SET status = 'reauth_required', auth_session_id = NULL,
            updated_at = pg_catalog.clock_timestamp()
        FROM invalid
        WHERE slot.id = invalid.id
        RETURNING invalid.was_selected, invalid.auth_session_id
      ), deleted_sessions AS (
        DELETE FROM auth_sessions auth_session USING stale
        WHERE auth_session.id = stale.auth_session_id
        RETURNING auth_session.id
      )
      SELECT count(*)::integer, coalesce(bool_or(was_selected), false)
      INTO changed_count, selected_lost FROM stale;

      IF changed_count > 0 THEN
        UPDATE managed_auth_session_sets changed_set
        SET generation = changed_set.generation + 1,
            actor_epoch = changed_set.actor_epoch + CASE WHEN selected_lost THEN 1 ELSE 0 END,
            selected_slot_id = CASE WHEN selected_lost THEN NULL ELSE changed_set.selected_slot_id END,
            state = CASE WHEN selected_lost THEN 'actor_change_required' ELSE changed_set.state END,
            updated_at = pg_catalog.clock_timestamp()
        WHERE changed_set.id = set_row.id RETURNING * INTO set_row;
      END IF;
      END IF;

      SELECT pg_catalog.jsonb_build_object(
        'projection', pg_catalog.jsonb_build_object(
          'mode', p_mode,
          'generation', set_row.generation::text,
          'actorEpoch', set_row.actor_epoch::text,
          'selectedSlotId', set_row.selected_slot_id,
          'state', set_row.state,
          'slots', coalesce((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', slot.id,
              'displayName', slot.display_name,
              'verifiedClaim', pg_catalog.jsonb_build_object(
                'kind', 'email', 'value', slot.verified_email
              ),
              'state', CASE
                WHEN slot.status = 'active'
                  AND identity_row.status = 'active'
                  AND binding.status = 'active'
                  AND identity_row.identity_revision = slot.identity_revision
                  AND identity_row.auth_revision = slot.auth_revision
                  AND binding.revision = slot.login_binding_revision
                THEN 'active' ELSE 'reauth_required' END
            ) ORDER BY slot.created_at, slot.id)
            FROM managed_auth_login_slots slot
            LEFT JOIN canonical_human_identities identity_row ON identity_row.id = slot.identity_id
            LEFT JOIN canonical_human_login_bindings binding ON binding.id = slot.login_binding_id
            WHERE slot.session_set_id = set_row.id AND slot.status <> 'revoked'
          ), '[]'::jsonb)
        ),
        'selected', CASE WHEN p_include_internal THEN (
          SELECT pg_catalog.jsonb_build_object(
            'slotId', slot.id, 'authSessionId', auth_session.id,
            'authUserId', slot.auth_user_id, 'token', auth_session.token,
            'email', auth_user.email, 'name', auth_user.name,
            'emailVerified', auth_user.email_verified
          )
          FROM managed_auth_login_slots slot
          INNER JOIN auth_sessions auth_session ON auth_session.id = slot.auth_session_id
          INNER JOIN auth_users auth_user ON auth_user.id = slot.auth_user_id
          INNER JOIN canonical_human_identities identity_row ON identity_row.id = slot.identity_id
          INNER JOIN canonical_human_login_bindings binding ON binding.id = slot.login_binding_id
          INNER JOIN canonical_human_identity_subjects subject_row
            ON subject_row.auth_user_id = slot.auth_user_id
           AND subject_row.identity_id = slot.identity_id
          WHERE slot.id = set_row.selected_slot_id AND slot.status = 'active'
            AND auth_session.user_id = slot.auth_user_id
            AND auth_session.identity_id = slot.identity_id
            AND auth_session.identity_revision = slot.identity_revision
            AND auth_session.auth_revision = slot.auth_revision
            AND auth_session.login_binding_id = slot.login_binding_id
            AND auth_session.login_binding_revision = slot.login_binding_revision
            AND identity_row.identity_revision = slot.identity_revision
            AND identity_row.auth_revision = slot.auth_revision
            AND binding.identity_id = slot.identity_id
            AND binding.revision = slot.login_binding_revision
            AND subject_row.status = 'active'
            AND (
              (identity_row.status = 'active' AND binding.status = 'active')
              OR (
                p_allow_recovery
                AND identity_row.status = 'recovery_required'
                AND binding.status = 'recovery_pending'
              )
            )
        ) ELSE NULL END,
        'internalSlots', CASE WHEN p_include_internal THEN coalesce((
          SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'slotId', slot.id, 'authSessionId', auth_session.id,
            'authUserId', slot.auth_user_id, 'token', auth_session.token,
            'email', auth_user.email, 'name', auth_user.name,
            'emailVerified', auth_user.email_verified
          ) ORDER BY slot.created_at, slot.id)
          FROM managed_auth_login_slots slot
          INNER JOIN auth_sessions auth_session ON auth_session.id = slot.auth_session_id
          INNER JOIN auth_users auth_user ON auth_user.id = slot.auth_user_id
          INNER JOIN canonical_human_identities identity_row ON identity_row.id = slot.identity_id
          INNER JOIN canonical_human_login_bindings binding ON binding.id = slot.login_binding_id
          INNER JOIN canonical_human_identity_subjects subject_row
            ON subject_row.auth_user_id = slot.auth_user_id
           AND subject_row.identity_id = slot.identity_id
          WHERE slot.session_set_id = set_row.id AND slot.status = 'active'
            AND auth_session.user_id = slot.auth_user_id
            AND auth_session.identity_id = slot.identity_id
            AND auth_session.identity_revision = slot.identity_revision
            AND auth_session.auth_revision = slot.auth_revision
            AND auth_session.login_binding_id = slot.login_binding_id
            AND auth_session.login_binding_revision = slot.login_binding_revision
            AND identity_row.identity_revision = slot.identity_revision
            AND identity_row.auth_revision = slot.auth_revision
            AND binding.identity_id = slot.identity_id
            AND binding.revision = slot.login_binding_revision
            AND subject_row.status = 'active'
            AND (
              (identity_row.status = 'active' AND binding.status = 'active')
              OR (
                p_allow_recovery
                AND slot.id = set_row.selected_slot_id
                AND identity_row.status = 'recovery_required'
                AND binding.status = 'recovery_pending'
              )
            )
        ), '[]'::jsonb) ELSE '[]'::jsonb END
      ) INTO result;
      PERFORM pg_catalog.set_config(
        'opengeni.managed_auth_session_set_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
      );
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.managed_auth_session_set_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true
      );
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_bootstrap(
      p_authority_hash text, p_csrf_hash text, p_auth_session_id text,
      p_mode text, p_operation_id uuid, p_request_digest text,
      p_expected_generation bigint, p_expected_actor_epoch bigint
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      session_row record;
      slot_id uuid;
      installation_uuid uuid;
      result jsonb;
      prior_operation managed_auth_session_set_operations%%ROWTYPE;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
      reclaimed_set_id uuid;
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_csrf_hash !~ '^[0-9a-f]{64}$'
        OR p_request_digest !~ '^[0-9a-f]{64}$' OR p_operation_id IS NULL
        OR p_expected_generation < 1 OR p_expected_actor_epoch < 1
        OR p_mode NOT IN ('legacy', 'dual', 'broker')
      THEN RAISE EXCEPTION 'managed auth session-set bootstrap is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      SELECT * INTO prior_operation FROM managed_auth_session_set_operations
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.operation_type <> 'bootstrap'
          OR prior_operation.request_digest <> p_request_digest
        THEN RAISE EXCEPTION 'managed auth operation id was reused' USING ERRCODE = '23505'; END IF;
        SELECT session_set.* INTO set_row FROM managed_auth_session_sets session_set
        INNER JOIN managed_auth_browser_installations installation
          ON installation.id = session_set.installation_id
        WHERE session_set.id = prior_operation.session_set_id
          AND session_set.authority_hash = p_authority_hash
          AND session_set.csrf_hash = p_csrf_hash
          AND session_set.revoked_at IS NULL AND installation.revoked_at IS NULL
        FOR UPDATE OF session_set, installation;
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth operation authority mismatch' USING ERRCODE = '42501'; END IF;
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN prior_operation.result;
      END IF;
      IF p_auth_session_id IS NOT NULL THEN
        SELECT session_set.id INTO reclaimed_set_id
        FROM managed_auth_login_slots slot
        INNER JOIN managed_auth_session_sets session_set ON session_set.id = slot.session_set_id
        INNER JOIN managed_auth_browser_installations installation
          ON installation.id = session_set.installation_id
        WHERE slot.auth_session_id = p_auth_session_id AND slot.status = 'active'
          AND session_set.revoked_at IS NULL AND installation.revoked_at IS NULL
          AND session_set.idle_expires_at > pg_catalog.clock_timestamp()
          AND session_set.absolute_expires_at > pg_catalog.clock_timestamp()
          AND installation.idle_expires_at > pg_catalog.clock_timestamp()
          AND installation.absolute_expires_at > pg_catalog.clock_timestamp()
        FOR UPDATE OF slot, session_set, installation;
        IF FOUND THEN
          UPDATE managed_auth_browser_installations installation SET
            authority_hash = p_authority_hash,
            last_seen_at = pg_catalog.clock_timestamp()
          FROM managed_auth_session_sets session_set
          WHERE session_set.id = reclaimed_set_id
            AND installation.id = session_set.installation_id
            AND installation.authority_hash <> p_authority_hash;
          UPDATE managed_auth_session_sets SET
            authority_hash = p_authority_hash,
            csrf_hash = p_csrf_hash,
            updated_at = pg_catalog.clock_timestamp()
          WHERE id = reclaimed_set_id AND authority_hash <> p_authority_hash;
        END IF;
      END IF;
      INSERT INTO managed_auth_browser_installations (authority_hash)
      VALUES (p_authority_hash)
      ON CONFLICT (authority_hash) DO NOTHING;
      SELECT id INTO installation_uuid FROM managed_auth_browser_installations
      WHERE authority_hash = p_authority_hash AND revoked_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'managed auth browser installation is unavailable' USING ERRCODE = '42501'; END IF;
      INSERT INTO managed_auth_session_sets (installation_id, authority_hash, csrf_hash)
      VALUES (installation_uuid, p_authority_hash, p_csrf_hash)
      ON CONFLICT (authority_hash) DO NOTHING;
      SELECT * INTO set_row FROM managed_auth_session_sets
      WHERE authority_hash = p_authority_hash AND revoked_at IS NULL FOR UPDATE;
      IF NOT FOUND OR set_row.csrf_hash <> p_csrf_hash THEN
        RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO prior_operation FROM managed_auth_session_set_operations
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.session_set_id <> set_row.id
          OR prior_operation.operation_type <> 'bootstrap'
          OR prior_operation.request_digest <> p_request_digest
        THEN RAISE EXCEPTION 'managed auth operation id was reused' USING ERRCODE = '23505'; END IF;
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN prior_operation.result;
      END IF;
      IF managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false) IS NULL THEN
        RAISE EXCEPTION 'managed auth session-set authority expired' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      IF set_row.generation <> p_expected_generation
        OR set_row.actor_epoch <> p_expected_actor_epoch
      THEN RAISE EXCEPTION 'managed auth session-set generation conflict' USING ERRCODE = '40001'; END IF;
      IF p_auth_session_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM managed_auth_login_slots WHERE session_set_id = set_row.id
      ) THEN
        SELECT auth_session.id, auth_session.user_id, auth_session.identity_id,
          auth_session.identity_revision, auth_session.auth_revision,
          auth_session.login_binding_id,
          auth_session.login_binding_revision, identity_row.display_name,
          auth_user.email
        INTO session_row
        FROM auth_sessions auth_session
        INNER JOIN auth_users auth_user ON auth_user.id = auth_session.user_id
        INNER JOIN canonical_human_identities identity_row
          ON identity_row.id = auth_session.identity_id
        INNER JOIN canonical_human_login_bindings binding
          ON binding.id = auth_session.login_binding_id
         AND binding.identity_id = auth_session.identity_id
        INNER JOIN canonical_human_identity_subjects subject_row
          ON subject_row.auth_user_id = auth_session.user_id
         AND subject_row.identity_id = auth_session.identity_id
        WHERE auth_session.id = p_auth_session_id
          AND auth_session.expires_at > pg_catalog.clock_timestamp()
          AND auth_session.identity_revision = identity_row.identity_revision
          AND auth_session.auth_revision = identity_row.auth_revision
          AND auth_session.login_binding_revision = binding.revision
          AND identity_row.status = 'active' AND binding.status = 'active'
          AND subject_row.status = 'active';
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth bootstrap session is unavailable' USING ERRCODE = '42501'; END IF;
        INSERT INTO managed_auth_login_slots (
          session_set_id, auth_session_id, auth_user_id, identity_id, login_binding_id,
          identity_revision, auth_revision, login_binding_revision, display_name, verified_email
        ) VALUES (
          set_row.id, session_row.id, session_row.user_id, session_row.identity_id,
          session_row.login_binding_id, session_row.identity_revision, session_row.auth_revision,
          session_row.login_binding_revision, session_row.display_name, session_row.email
        ) RETURNING id INTO slot_id;
        UPDATE managed_auth_session_sets SET selected_slot_id = slot_id, updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id RETURNING * INTO set_row;
      END IF;
      result := managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false);
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      INSERT INTO managed_auth_session_set_operations (
        operation_id, session_set_id, operation_type, request_digest,
        expected_generation, result_generation, result_actor_epoch, outcome, result
      ) VALUES (
        p_operation_id, set_row.id, 'bootstrap', p_request_digest,
        p_expected_generation, set_row.generation, set_row.actor_epoch, 'applied', result
      );
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_begin_transaction(
      p_authority_hash text, p_csrf_hash text, p_operation_id uuid,
      p_request_digest text, p_expected_generation bigint, p_transaction_id uuid,
      p_expected_actor_epoch bigint,
      p_transaction_secret_hash text, p_kind text, p_target_slot_id uuid,
      p_return_intent_id uuid, p_return_path text, p_expires_at timestamptz
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      slot_row managed_auth_login_slots%%ROWTYPE;
      prior_operation managed_auth_session_set_operations%%ROWTYPE;
      installation_uuid uuid;
      result jsonb;
      previous_marker text := pg_catalog.current_setting('opengeni.managed_auth_session_set_lifecycle', true);
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_csrf_hash !~ '^[0-9a-f]{64}$'
        OR p_request_digest !~ '^[0-9a-f]{64}$' OR p_transaction_secret_hash !~ '^[0-9a-f]{64}$'
        OR p_operation_id IS NULL
        OR p_kind NOT IN ('add', 'reauth') OR p_expected_generation < 1 OR p_expected_actor_epoch < 1
        OR p_expires_at <= pg_catalog.clock_timestamp() OR p_expires_at > pg_catalog.clock_timestamp() + interval '10 minutes'
        OR ((p_kind = 'reauth') <> (p_target_slot_id IS NOT NULL))
        OR ((p_return_intent_id IS NULL) <> (p_return_path IS NULL))
      THEN RAISE EXCEPTION 'managed auth login transaction is invalid' USING ERRCODE = '22023'; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT * INTO set_row FROM managed_auth_session_sets
      WHERE authority_hash = p_authority_hash FOR UPDATE;
      IF NOT FOUND THEN
        IF p_kind <> 'add' OR p_expected_generation <> 1 OR p_expected_actor_epoch <> 1
        THEN RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501'; END IF;
        INSERT INTO managed_auth_browser_installations (authority_hash)
        VALUES (p_authority_hash)
        ON CONFLICT (authority_hash) DO NOTHING;
        SELECT id INTO installation_uuid FROM managed_auth_browser_installations
        WHERE authority_hash = p_authority_hash AND revoked_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'managed auth browser installation is unavailable' USING ERRCODE = '42501';
        END IF;
        INSERT INTO managed_auth_session_sets (installation_id, authority_hash, csrf_hash)
        VALUES (installation_uuid, p_authority_hash, p_csrf_hash)
        ON CONFLICT (authority_hash) DO NOTHING;
        SELECT * INTO set_row FROM managed_auth_session_sets
        WHERE authority_hash = p_authority_hash AND revoked_at IS NULL FOR UPDATE;
      END IF;
      IF NOT FOUND OR set_row.csrf_hash <> p_csrf_hash THEN
        RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO prior_operation FROM managed_auth_session_set_operations WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.session_set_id <> set_row.id OR prior_operation.request_digest <> p_request_digest
          OR prior_operation.operation_type <> 'begin_' || p_kind
        THEN RAISE EXCEPTION 'managed auth operation id was reused' USING ERRCODE = '23505'; END IF;
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        RETURN prior_operation.result;
      END IF;
      IF set_row.revoked_at IS NOT NULL
        OR managed_auth_session_set_snapshot(p_authority_hash, 'dual', false, false) IS NULL
      THEN RAISE EXCEPTION 'managed auth session-set authority expired' USING ERRCODE = '42501'; END IF;
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      IF set_row.generation <> p_expected_generation OR set_row.actor_epoch <> p_expected_actor_epoch
      THEN RAISE EXCEPTION 'managed auth session-set generation conflict' USING ERRCODE = '40001'; END IF;
      IF p_kind = 'reauth' THEN
        SELECT * INTO slot_row FROM managed_auth_login_slots
        WHERE id = p_target_slot_id AND session_set_id = set_row.id AND status <> 'revoked' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth login slot is unavailable' USING ERRCODE = 'P0002'; END IF;
      END IF;
      IF p_return_intent_id IS NOT NULL THEN
        INSERT INTO managed_auth_login_return_intents (id, session_set_id, path, expires_at)
        VALUES (p_return_intent_id, set_row.id, p_return_path, p_expires_at);
      END IF;
      INSERT INTO managed_auth_login_transactions (
        id, session_set_id, secret_hash, kind, target_slot_id,
        expected_identity_id, expected_login_binding_id,
        expected_identity_revision, expected_auth_revision, expected_login_binding_revision,
        expected_generation,
        return_intent_id, expires_at
      ) VALUES (
        p_transaction_id, set_row.id, p_transaction_secret_hash, p_kind, p_target_slot_id,
        CASE WHEN p_kind = 'reauth' THEN slot_row.identity_id ELSE NULL END,
        CASE WHEN p_kind = 'reauth' THEN slot_row.login_binding_id ELSE NULL END,
        CASE WHEN p_kind = 'reauth' THEN slot_row.identity_revision ELSE NULL END,
        CASE WHEN p_kind = 'reauth' THEN slot_row.auth_revision ELSE NULL END,
        CASE WHEN p_kind = 'reauth' THEN slot_row.login_binding_revision ELSE NULL END,
        p_expected_generation, p_return_intent_id, p_expires_at
      );
      result := pg_catalog.jsonb_build_object(
        'id', p_transaction_id, 'kind', p_kind,
        'expiresAt', p_expires_at, 'returnIntentId', p_return_intent_id
      );
      INSERT INTO managed_auth_session_set_operations (
        operation_id, session_set_id, operation_type, request_digest,
        expected_generation, result_generation, result_actor_epoch, target_slot_id, outcome, result
      ) VALUES (
        p_operation_id, set_row.id, 'begin_' || p_kind, p_request_digest,
        set_row.generation, set_row.generation, set_row.actor_epoch, p_target_slot_id, 'applied', result
      );
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_complete_transaction(
      p_authority_hash text, p_csrf_hash text, p_operation_id uuid,
      p_request_digest text, p_expected_generation bigint,
      p_expected_actor_epoch bigint,
      p_transaction_id uuid, p_transaction_secret_hash text, p_auth_session_id text,
      p_mode text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      tx_row managed_auth_login_transactions%%ROWTYPE;
      session_row record;
      slot_row managed_auth_login_slots%%ROWTYPE;
      prior_operation managed_auth_session_set_operations%%ROWTYPE;
      old_auth_session_id text;
      slot_id uuid;
      selected_rebound boolean := false;
      return_path text;
      result jsonb;
      previous_marker text := pg_catalog.current_setting('opengeni.managed_auth_session_set_lifecycle', true);
      previous_canonical_marker text := pg_catalog.current_setting('opengeni.canonical_human_identity_lifecycle', true);
    BEGIN
      IF p_request_digest !~ '^[0-9a-f]{64}$' OR p_transaction_secret_hash !~ '^[0-9a-f]{64}$'
        OR p_expected_generation < 1 OR p_expected_actor_epoch < 1
        OR p_mode NOT IN ('legacy', 'dual', 'broker')
      THEN RAISE EXCEPTION 'managed auth transaction completion is invalid' USING ERRCODE = '22023'; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      SELECT * INTO set_row FROM managed_auth_session_sets
      WHERE authority_hash = p_authority_hash FOR UPDATE;
      IF NOT FOUND OR set_row.csrf_hash <> p_csrf_hash THEN RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501'; END IF;
      SELECT * INTO prior_operation FROM managed_auth_session_set_operations WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.session_set_id <> set_row.id OR prior_operation.request_digest <> p_request_digest
          OR prior_operation.operation_type NOT IN ('complete_add', 'complete_reauth')
        THEN RAISE EXCEPTION 'managed auth operation id was reused' USING ERRCODE = '23505'; END IF;
        DELETE FROM auth_sessions replay_session
        WHERE replay_session.id = p_auth_session_id
          AND NOT EXISTS (
            SELECT 1 FROM managed_auth_login_slots slot
            WHERE slot.id = prior_operation.target_slot_id
              AND slot.auth_session_id = replay_session.id
          );
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
        RETURN prior_operation.result;
      END IF;
      IF set_row.revoked_at IS NOT NULL
        OR managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false) IS NULL
      THEN RAISE EXCEPTION 'managed auth session-set authority expired' USING ERRCODE = '42501'; END IF;
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      IF set_row.generation <> p_expected_generation OR set_row.actor_epoch <> p_expected_actor_epoch
      THEN RAISE EXCEPTION 'managed auth session-set generation conflict' USING ERRCODE = '40001'; END IF;
      SELECT * INTO tx_row FROM managed_auth_login_transactions
      WHERE id = p_transaction_id AND session_set_id = set_row.id FOR UPDATE;
      IF NOT FOUND OR tx_row.secret_hash <> p_transaction_secret_hash OR tx_row.status <> 'pending'
        OR tx_row.expires_at <= pg_catalog.clock_timestamp() OR tx_row.expected_generation <> p_expected_generation
      THEN RAISE EXCEPTION 'managed auth login transaction is unavailable' USING ERRCODE = '42501'; END IF;
      SELECT auth_session.id, auth_session.user_id, auth_session.identity_id,
        auth_session.identity_revision, auth_session.auth_revision,
        auth_session.login_binding_id,
        auth_session.login_binding_revision, identity_row.display_name, auth_user.email
      INTO session_row
      FROM auth_sessions auth_session
      INNER JOIN auth_users auth_user ON auth_user.id = auth_session.user_id
      INNER JOIN canonical_human_identities identity_row ON identity_row.id = auth_session.identity_id
      INNER JOIN canonical_human_login_bindings binding
        ON binding.id = auth_session.login_binding_id
       AND binding.identity_id = auth_session.identity_id
      INNER JOIN canonical_human_identity_subjects subject_row
        ON subject_row.auth_user_id = auth_session.user_id AND subject_row.identity_id = auth_session.identity_id
      WHERE auth_session.id = p_auth_session_id AND auth_session.expires_at > pg_catalog.clock_timestamp()
        AND auth_session.identity_revision = identity_row.identity_revision
        AND auth_session.auth_revision = identity_row.auth_revision
        AND auth_session.login_binding_revision = binding.revision
        AND subject_row.status = 'active'
        AND (
          (identity_row.status = 'active' AND binding.status = 'active')
          OR (
            tx_row.kind = 'reauth'
            AND auth_session.identity_id = tx_row.expected_identity_id
            AND auth_session.login_binding_id = tx_row.expected_login_binding_id
            AND identity_row.status = 'recovery_required'
            AND binding.status = 'recovery_pending'
          )
        );
      IF NOT FOUND THEN RAISE EXCEPTION 'managed auth provider session is unavailable' USING ERRCODE = '42501'; END IF;
      IF tx_row.kind = 'reauth' THEN
        IF session_row.identity_id <> tx_row.expected_identity_id
          OR session_row.login_binding_id <> tx_row.expected_login_binding_id
          OR session_row.identity_revision <> tx_row.expected_identity_revision
          OR session_row.auth_revision <> tx_row.expected_auth_revision
          OR session_row.login_binding_revision <> tx_row.expected_login_binding_revision
        THEN RAISE EXCEPTION 'managed auth reauthentication binding mismatch' USING ERRCODE = '42501'; END IF;
        SELECT * INTO slot_row FROM managed_auth_login_slots
        WHERE id = tx_row.target_slot_id AND session_set_id = set_row.id AND status <> 'revoked' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth login slot is unavailable' USING ERRCODE = 'P0002'; END IF;
      ELSE
        SELECT * INTO slot_row FROM managed_auth_login_slots
        WHERE session_set_id = set_row.id
          AND login_binding_id = session_row.login_binding_id
          AND status <> 'revoked' FOR UPDATE;
        IF FOUND THEN
          RAISE EXCEPTION 'managed auth login binding already has a slot' USING ERRCODE = 'P0003';
        END IF;
        IF (
          SELECT count(*) FROM managed_auth_login_slots WHERE session_set_id = set_row.id AND status <> 'revoked'
        ) >= 8 THEN RAISE EXCEPTION 'managed auth login slot limit reached' USING ERRCODE = '54000'; END IF;
      END IF;
      IF tx_row.kind = 'reauth' THEN
        old_auth_session_id := slot_row.auth_session_id;
        slot_id := slot_row.id;
        selected_rebound := slot_row.id = set_row.selected_slot_id;
        IF selected_rebound THEN
          DELETE FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
          IF EXISTS (
            SELECT 1 FROM managed_auth_actor_mutation_leases
            WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
          ) THEN
            RAISE EXCEPTION 'managed auth actor has an in-flight mutation'
              USING ERRCODE = '55P03';
          END IF;
        END IF;
        UPDATE managed_auth_login_slots SET
          auth_session_id = session_row.id, auth_user_id = session_row.user_id,
          identity_id = session_row.identity_id, login_binding_id = session_row.login_binding_id,
          identity_revision = session_row.identity_revision, auth_revision = session_row.auth_revision,
          login_binding_revision = session_row.login_binding_revision,
          display_name = session_row.display_name, verified_email = session_row.email,
          status = 'active', revoked_at = NULL, updated_at = pg_catalog.clock_timestamp()
        WHERE id = slot_row.id;
      ELSE
        INSERT INTO managed_auth_login_slots (
          session_set_id, auth_session_id, auth_user_id, identity_id, login_binding_id,
          identity_revision, auth_revision, login_binding_revision, display_name, verified_email
        ) VALUES (
          set_row.id, session_row.id, session_row.user_id, session_row.identity_id,
          session_row.login_binding_id, session_row.identity_revision, session_row.auth_revision,
          session_row.login_binding_revision, session_row.display_name, session_row.email
        ) RETURNING id INTO slot_id;
      END IF;
      UPDATE managed_auth_login_transactions SET status = 'consumed', consumed_at = pg_catalog.clock_timestamp()
      WHERE id = tx_row.id;
      IF tx_row.return_intent_id IS NOT NULL THEN
        UPDATE managed_auth_login_return_intents SET consumed_at = pg_catalog.clock_timestamp()
        WHERE id = tx_row.return_intent_id AND consumed_at IS NULL AND expires_at > pg_catalog.clock_timestamp()
        RETURNING path INTO return_path;
      END IF;
      UPDATE managed_auth_session_sets changed_set SET
        generation = changed_set.generation + 1,
        actor_epoch = changed_set.actor_epoch + CASE WHEN selected_rebound THEN 1 ELSE 0 END,
        state = CASE WHEN selected_rebound THEN 'ready' ELSE changed_set.state END,
        updated_at = pg_catalog.clock_timestamp()
      WHERE changed_set.id = set_row.id RETURNING * INTO set_row;
      IF old_auth_session_id IS NOT NULL AND old_auth_session_id <> session_row.id THEN
        DELETE FROM auth_sessions WHERE id = old_auth_session_id;
      END IF;
      result := managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false)
        || pg_catalog.jsonb_build_object('returnIntent', return_path);
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      INSERT INTO managed_auth_session_set_operations (
        operation_id, session_set_id, operation_type, request_digest,
        expected_generation, result_generation, result_actor_epoch, target_slot_id, outcome, result
      ) VALUES (
        p_operation_id, set_row.id, 'complete_' || tx_row.kind, p_request_digest,
        p_expected_generation, set_row.generation, set_row.actor_epoch, slot_id, 'applied', result
      );
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_mutate(
      p_authority_hash text, p_csrf_hash text, p_operation_id uuid,
      p_request_digest text, p_expected_generation bigint, p_expected_actor_epoch bigint,
      p_operation_type text,
      p_target_slot_id uuid, p_replacement_slot_id uuid,
      p_transaction_id uuid, p_transaction_secret_hash text, p_mode text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      target_slot managed_auth_login_slots%%ROWTYPE;
      replacement_slot managed_auth_login_slots%%ROWTYPE;
      tx_row managed_auth_login_transactions%%ROWTYPE;
      prior_operation managed_auth_session_set_operations%%ROWTYPE;
      was_selected boolean := false;
      result jsonb;
      previous_marker text := pg_catalog.current_setting('opengeni.managed_auth_session_set_lifecycle', true);
    BEGIN
      IF p_request_digest !~ '^[0-9a-f]{64}$' OR p_expected_generation < 1
        OR p_expected_actor_epoch < 1
        OR p_operation_type NOT IN ('cancel_transaction', 'select', 'logout_one', 'logout_all')
        OR p_mode NOT IN ('legacy', 'dual', 'broker')
      THEN RAISE EXCEPTION 'managed auth session-set mutation is invalid' USING ERRCODE = '22023'; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT * INTO set_row FROM managed_auth_session_sets
      WHERE authority_hash = p_authority_hash FOR UPDATE;
      IF NOT FOUND OR set_row.csrf_hash <> p_csrf_hash THEN RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501'; END IF;
      SELECT * INTO prior_operation FROM managed_auth_session_set_operations WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.session_set_id <> set_row.id OR prior_operation.request_digest <> p_request_digest
          OR prior_operation.operation_type <> p_operation_type
        THEN RAISE EXCEPTION 'managed auth operation id was reused' USING ERRCODE = '23505'; END IF;
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        RETURN prior_operation.result;
      END IF;
      IF set_row.revoked_at IS NOT NULL THEN RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501'; END IF;
      IF managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false) IS NULL THEN
        RAISE EXCEPTION 'managed auth session-set authority expired' USING ERRCODE = '42501';
      END IF;
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      IF set_row.generation <> p_expected_generation OR set_row.actor_epoch <> p_expected_actor_epoch
      THEN RAISE EXCEPTION 'managed auth session-set generation conflict' USING ERRCODE = '40001'; END IF;
      IF p_operation_type = 'cancel_transaction' THEN
        IF p_transaction_secret_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'managed auth transaction secret is invalid' USING ERRCODE = '22023'; END IF;
        SELECT * INTO tx_row FROM managed_auth_login_transactions
        WHERE id = p_transaction_id AND session_set_id = set_row.id FOR UPDATE;
        IF NOT FOUND OR tx_row.secret_hash <> p_transaction_secret_hash OR tx_row.status <> 'pending'
        THEN RAISE EXCEPTION 'managed auth login transaction is unavailable' USING ERRCODE = '42501'; END IF;
        UPDATE managed_auth_login_transactions SET status = 'cancelled', consumed_at = pg_catalog.clock_timestamp()
        WHERE id = tx_row.id;
        UPDATE managed_auth_login_return_intents SET consumed_at = pg_catalog.clock_timestamp()
        WHERE id = tx_row.return_intent_id AND consumed_at IS NULL;
      ELSIF p_operation_type = 'select' THEN
        SELECT * INTO target_slot FROM managed_auth_login_slots
        WHERE id = p_target_slot_id AND session_set_id = set_row.id AND status = 'active'
          AND auth_session_id IS NOT NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth login slot is unavailable' USING ERRCODE = 'P0002'; END IF;
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
        ) THEN
          RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
        END IF;
        UPDATE managed_auth_session_sets SET selected_slot_id = target_slot.id,
          generation = generation + 1, actor_epoch = actor_epoch + 1,
          state = 'ready', updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id RETURNING * INTO set_row;
      ELSIF p_operation_type = 'logout_one' THEN
        SELECT * INTO target_slot FROM managed_auth_login_slots
        WHERE id = p_target_slot_id AND session_set_id = set_row.id AND status <> 'revoked' FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'managed auth login slot is unavailable' USING ERRCODE = 'P0002'; END IF;
        was_selected := target_slot.id = set_row.selected_slot_id;
        IF NOT was_selected AND p_replacement_slot_id IS NOT NULL THEN
          RAISE EXCEPTION 'replacement is valid only for the selected slot' USING ERRCODE = '22023';
        END IF;
        IF p_replacement_slot_id IS NOT NULL THEN
          SELECT * INTO replacement_slot FROM managed_auth_login_slots
          WHERE id = p_replacement_slot_id AND session_set_id = set_row.id
            AND id <> target_slot.id AND status = 'active' AND auth_session_id IS NOT NULL FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'managed auth replacement slot is unavailable' USING ERRCODE = 'P0002'; END IF;
        END IF;
        IF was_selected THEN
          DELETE FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
          IF EXISTS (
            SELECT 1 FROM managed_auth_actor_mutation_leases
            WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
          ) THEN
            RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
          END IF;
        END IF;
        UPDATE managed_auth_login_slots SET status = 'revoked', auth_session_id = NULL,
          revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
        WHERE id = target_slot.id;
        IF target_slot.auth_session_id IS NOT NULL THEN DELETE FROM auth_sessions WHERE id = target_slot.auth_session_id; END IF;
        UPDATE managed_auth_session_sets SET
          selected_slot_id = CASE WHEN was_selected THEN p_replacement_slot_id ELSE selected_slot_id END,
          generation = generation + 1,
          actor_epoch = actor_epoch + CASE WHEN was_selected THEN 1 ELSE 0 END,
          state = CASE
            WHEN was_selected AND p_replacement_slot_id IS NULL THEN 'actor_change_required'
            WHEN was_selected THEN 'ready'
            ELSE state
          END,
          updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id RETURNING * INTO set_row;
      ELSE
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND actor_epoch = set_row.actor_epoch
        ) THEN
          RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
        END IF;
        DELETE FROM auth_sessions auth_session USING managed_auth_login_slots slot
        WHERE slot.session_set_id = set_row.id AND slot.status <> 'revoked'
          AND auth_session.id = slot.auth_session_id;
        UPDATE managed_auth_login_slots SET status = 'revoked', auth_session_id = NULL,
          revoked_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
        WHERE session_set_id = set_row.id AND status <> 'revoked';
        UPDATE managed_auth_session_sets SET selected_slot_id = NULL,
          generation = generation + 1, actor_epoch = actor_epoch + 1,
          state = 'actor_change_required', revoked_at = pg_catalog.clock_timestamp(),
          updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id RETURNING * INTO set_row;
        UPDATE managed_auth_browser_installations SET revoked_at = pg_catalog.clock_timestamp(),
          last_seen_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.installation_id AND revoked_at IS NULL;
      END IF;
      result := CASE WHEN p_operation_type = 'logout_all' THEN
        pg_catalog.jsonb_build_object(
          'generation', set_row.generation::text,
          'actorEpoch', set_row.actor_epoch::text,
          'state', 'logged_out'
        )
      ELSE managed_auth_session_set_snapshot(p_authority_hash, p_mode, false, false) END;
      SELECT * INTO set_row FROM managed_auth_session_sets WHERE id = set_row.id FOR UPDATE;
      INSERT INTO managed_auth_session_set_operations (
        operation_id, session_set_id, operation_type, request_digest,
        expected_generation, result_generation, result_actor_epoch,
        target_slot_id, replacement_slot_id, outcome, result
      ) VALUES (
        p_operation_id, set_row.id, p_operation_type, p_request_digest,
        p_expected_generation, set_row.generation, set_row.actor_epoch,
        p_target_slot_id, p_replacement_slot_id, 'applied', result
      );
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_actor_mutation_fence(
      p_authority_hash text, p_actor_epoch bigint, p_request_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_actor_epoch < 1 OR p_request_id IS NULL
      THEN RAISE EXCEPTION 'managed auth mutation fence is invalid' USING ERRCODE = '22023'; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT * INTO set_row FROM managed_auth_session_sets
      WHERE authority_hash = p_authority_hash AND revoked_at IS NULL FOR UPDATE;
      IF NOT FOUND OR set_row.actor_epoch <> p_actor_epoch OR NOT EXISTS (
        SELECT 1 FROM managed_auth_actor_mutation_leases lease
        WHERE lease.session_set_id = set_row.id AND lease.request_id = p_request_id
          AND lease.actor_epoch = p_actor_epoch AND lease.expires_at > pg_catalog.clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'managed auth actor changed before fenced mutation' USING ERRCODE = '40001';
      END IF;
      DELETE FROM managed_auth_actor_mutation_leases
      WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
      IF EXISTS (
        SELECT 1 FROM managed_auth_actor_mutation_leases lease
        WHERE lease.session_set_id = set_row.id AND lease.actor_epoch = p_actor_epoch
          AND lease.request_id <> p_request_id
      ) THEN
        RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.managed_auth_actor_mutation_request_id', p_request_id::text, true
      );
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN true;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_slot_invalidation()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      slot_row managed_auth_login_slots%%ROWTYPE;
      set_row managed_auth_session_sets%%ROWTYPE;
      identity_status text;
      binding_status text;
      current_identity_revision bigint;
      current_auth_revision bigint;
      current_binding_revision bigint;
      recovery_transition boolean;
      own_request_text text := pg_catalog.current_setting(
        'opengeni.managed_auth_actor_mutation_request_id', true
      );
      own_request_id uuid;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF own_request_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN own_request_id := own_request_text::uuid; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      FOR slot_row IN
        SELECT * FROM managed_auth_login_slots
        WHERE auth_session_id = OLD.id AND status <> 'revoked'
        ORDER BY session_set_id, id
      LOOP
        SELECT * INTO set_row FROM managed_auth_session_sets
        WHERE id = slot_row.session_set_id FOR UPDATE;
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases lease
          WHERE lease.session_set_id = set_row.id AND lease.actor_epoch = set_row.actor_epoch
            AND (own_request_id IS NULL OR lease.request_id <> own_request_id)
        ) THEN
          RAISE EXCEPTION 'managed auth actor has an in-flight mutation' USING ERRCODE = '55P03';
        END IF;
        IF own_request_id IS NOT NULL THEN
          DELETE FROM managed_auth_actor_mutation_leases
          WHERE session_set_id = set_row.id AND request_id = own_request_id
            AND actor_epoch = set_row.actor_epoch;
        END IF;
        SELECT identity_row.status, binding.status, identity_row.identity_revision,
          identity_row.auth_revision, binding.revision
        INTO identity_status, binding_status, current_identity_revision,
          current_auth_revision, current_binding_revision
        FROM canonical_human_identities identity_row
        INNER JOIN canonical_human_login_bindings binding
          ON binding.id = slot_row.login_binding_id
         AND binding.identity_id = identity_row.id
        WHERE identity_row.id = slot_row.identity_id;
        recovery_transition := slot_row.id = set_row.selected_slot_id
          AND identity_status = 'recovery_required' AND binding_status = 'recovery_pending';
        UPDATE managed_auth_login_slots SET
          auth_session_id = NULL,
          status = CASE WHEN recovery_transition THEN 'active' ELSE 'reauth_required' END,
          identity_revision = CASE WHEN recovery_transition THEN current_identity_revision ELSE identity_revision END,
          auth_revision = CASE WHEN recovery_transition THEN current_auth_revision ELSE auth_revision END,
          login_binding_revision = CASE WHEN recovery_transition THEN current_binding_revision ELSE login_binding_revision END,
          updated_at = pg_catalog.clock_timestamp()
        WHERE id = slot_row.id;
        UPDATE managed_auth_session_sets changed_set SET
          generation = changed_set.generation + 1,
          actor_epoch = changed_set.actor_epoch
            + CASE WHEN slot_row.id = set_row.selected_slot_id THEN 1 ELSE 0 END,
          selected_slot_id = CASE
            WHEN slot_row.id = set_row.selected_slot_id AND NOT recovery_transition THEN NULL
            ELSE changed_set.selected_slot_id END,
          state = CASE
            WHEN slot_row.id = set_row.selected_slot_id THEN 'actor_change_required'
            ELSE changed_set.state END,
          updated_at = pg_catalog.clock_timestamp()
        WHERE changed_set.id = set_row.id;
      END LOOP;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN OLD;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'CREATE TRIGGER managed_auth_session_slot_invalidation BEFORE DELETE ON %I.auth_sessions '
      || 'FOR EACH ROW EXECUTE FUNCTION %I.managed_auth_session_slot_invalidation()',
    data_schema, data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.managed_auth_session_slot_invalidation() FROM PUBLIC',
    data_schema
  );

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_actor_mutation_lease_acquire(
      p_authority_hash text, p_actor_epoch bigint, p_request_id uuid, p_lease_seconds integer
    ) RETURNS timestamptz
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      lease_expiry timestamptz;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_actor_epoch < 1
        OR p_request_id IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 900
      THEN RAISE EXCEPTION 'managed auth mutation lease is invalid' USING ERRCODE = '22023'; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT session_set.* INTO set_row
      FROM managed_auth_session_sets session_set
      INNER JOIN managed_auth_browser_installations installation
        ON installation.id = session_set.installation_id
      WHERE session_set.authority_hash = p_authority_hash
        AND session_set.revoked_at IS NULL AND installation.revoked_at IS NULL
        AND session_set.idle_expires_at > pg_catalog.clock_timestamp()
        AND session_set.absolute_expires_at > pg_catalog.clock_timestamp()
        AND installation.idle_expires_at > pg_catalog.clock_timestamp()
        AND installation.absolute_expires_at > pg_catalog.clock_timestamp()
      FOR UPDATE OF session_set, installation;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'managed auth session-set authority denied' USING ERRCODE = '42501';
      END IF;
      IF set_row.actor_epoch <> p_actor_epoch THEN
        RAISE EXCEPTION 'managed auth actor changed before mutation lease'
          USING ERRCODE = '40001';
      END IF;
      IF set_row.selected_slot_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM managed_auth_login_slots slot
        WHERE slot.id = set_row.selected_slot_id AND slot.session_set_id = set_row.id
          AND slot.status = 'active' AND slot.auth_session_id IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'managed auth selected actor is unavailable' USING ERRCODE = '42501';
      END IF;
      DELETE FROM managed_auth_actor_mutation_leases
      WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
      lease_expiry := pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds);
      INSERT INTO managed_auth_actor_mutation_leases (
        session_set_id, request_id, actor_epoch, acquired_at, expires_at
      ) VALUES (
        set_row.id, p_request_id, p_actor_epoch, pg_catalog.clock_timestamp(), lease_expiry
      )
      ON CONFLICT (session_set_id, request_id) DO UPDATE SET
        actor_epoch = EXCLUDED.actor_epoch,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at
      WHERE managed_auth_actor_mutation_leases.actor_epoch = EXCLUDED.actor_epoch;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'managed auth mutation lease identity changed' USING ERRCODE = '40001';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN lease_expiry;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_actor_mutation_lease_release(
      p_authority_hash text, p_request_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      released boolean;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_request_id IS NULL THEN RETURN false; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      DELETE FROM managed_auth_actor_mutation_leases lease
      USING managed_auth_session_sets session_set
      WHERE lease.session_set_id = session_set.id
        AND session_set.authority_hash = p_authority_hash
        AND lease.request_id = p_request_id;
      released := FOUND;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN released;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_session_set_operation_receipt(
      p_authority_hash text, p_operation_id uuid, p_request_digest text, p_operation_kind text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      operation_row managed_auth_session_set_operations%%ROWTYPE;
      set_row managed_auth_session_sets%%ROWTYPE;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_operation_id IS NULL
        OR p_request_digest !~ '^[0-9a-f]{64}$' OR p_operation_kind <> 'complete'
      THEN RETURN NULL; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT operation.* INTO operation_row FROM managed_auth_session_set_operations operation
      WHERE operation.operation_id = p_operation_id
        AND operation.request_digest = p_request_digest
        AND operation.operation_type IN ('complete_add', 'complete_reauth');
      IF NOT FOUND THEN
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        RETURN NULL;
      END IF;
      SELECT session_set.* INTO set_row FROM managed_auth_session_sets session_set
      INNER JOIN managed_auth_browser_installations installation
        ON installation.id = session_set.installation_id
      WHERE session_set.id = operation_row.session_set_id
        AND session_set.authority_hash = p_authority_hash
      FOR UPDATE OF session_set, installation;
      IF NOT FOUND THEN
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        RETURN NULL;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN operation_row.result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_adopted_session_snapshot(
      p_auth_session_id text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      snapshot jsonb;
      selected jsonb;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_auth_session_id IS NULL OR pg_catalog.length(p_auth_session_id) NOT BETWEEN 1 AND 255
      THEN RETURN NULL; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT session_set.* INTO set_row
      FROM managed_auth_login_slots slot
      INNER JOIN managed_auth_session_sets session_set ON session_set.id = slot.session_set_id
      WHERE slot.auth_session_id = p_auth_session_id AND slot.status <> 'revoked';
      IF NOT FOUND THEN
        PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
        RETURN NULL;
      END IF;
      snapshot := managed_auth_session_set_snapshot(
        set_row.authority_hash, 'dual', true, false, true
      );
      selected := CASE
        WHEN snapshot->'selected'->>'authSessionId' = p_auth_session_id
        THEN snapshot->'selected' ELSE NULL END;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN pg_catalog.jsonb_build_object(
        'authorityHash', set_row.authority_hash,
        'actorEpoch', coalesce(snapshot->'projection'->>'actorEpoch', set_row.actor_epoch::text),
        'selected', selected
      );
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_actor_mutation_lease_validate(
      p_authority_hash text, p_actor_epoch bigint, p_request_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      valid boolean := false;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
    BEGIN
      IF p_authority_hash !~ '^[0-9a-f]{64}$' OR p_actor_epoch < 1 OR p_request_id IS NULL
      THEN RETURN false; END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      SELECT session_set.* INTO set_row
      FROM managed_auth_session_sets session_set
      INNER JOIN managed_auth_browser_installations installation
        ON installation.id = session_set.installation_id
      WHERE session_set.authority_hash = p_authority_hash
      FOR UPDATE OF session_set, installation;
      IF FOUND THEN
        SELECT set_row.revoked_at IS NULL
          AND set_row.actor_epoch = p_actor_epoch
          AND set_row.idle_expires_at > pg_catalog.clock_timestamp()
          AND set_row.absolute_expires_at > pg_catalog.clock_timestamp()
          AND installation.revoked_at IS NULL
          AND installation.idle_expires_at > pg_catalog.clock_timestamp()
          AND installation.absolute_expires_at > pg_catalog.clock_timestamp()
          AND EXISTS (
            SELECT 1 FROM managed_auth_actor_mutation_leases lease
            WHERE lease.session_set_id = set_row.id
              AND lease.request_id = p_request_id
              AND lease.actor_epoch = p_actor_epoch
              AND lease.expires_at > pg_catalog.clock_timestamp()
          )
        INTO valid
        FROM managed_auth_browser_installations installation
        WHERE installation.id = set_row.installation_id;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RETURN coalesce(valid, false);
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_isolated_session_reap(
      p_limit integer DEFAULT 100
    ) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      reaped integer := 0;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'managed auth orphan reap limit is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      WITH victims AS (
        SELECT auth_session.id
        FROM auth_sessions auth_session
        LEFT JOIN managed_auth_login_transactions login_transaction
          ON login_transaction.id = auth_session.managed_auth_login_transaction_id
        WHERE auth_session.managed_auth_login_transaction_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM managed_auth_login_slots slot
            WHERE slot.auth_session_id = auth_session.id AND slot.status <> 'revoked'
          )
          AND (
            login_transaction.id IS NULL OR login_transaction.status <> 'pending'
            OR login_transaction.expires_at <= pg_catalog.clock_timestamp()
          )
        ORDER BY auth_session.created_at, auth_session.id
        FOR UPDATE OF auth_session SKIP LOCKED
        LIMIT p_limit
      ), deleted AS (
        DELETE FROM auth_sessions auth_session USING victims
        WHERE auth_session.id = victims.id
        RETURNING auth_session.id
      )
      SELECT count(*)::integer INTO reaped FROM deleted;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN reaped;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.managed_auth_expired_session_set_reap(
      p_limit integer DEFAULT 100
    ) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      set_row managed_auth_session_sets%%ROWTYPE;
      retired integer := 0;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.managed_auth_session_set_lifecycle', true
      );
      previous_canonical_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'managed auth expired-set reap limit is invalid' USING ERRCODE = '22023';
      END IF;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', 'active', true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
      FOR set_row IN
        SELECT session_set.*
        FROM managed_auth_session_sets session_set
        INNER JOIN managed_auth_browser_installations installation
          ON installation.id = session_set.installation_id
        WHERE session_set.revoked_at IS NULL
          AND (
            session_set.idle_expires_at <= pg_catalog.clock_timestamp()
            OR session_set.absolute_expires_at <= pg_catalog.clock_timestamp()
            OR installation.revoked_at IS NOT NULL
            OR installation.idle_expires_at <= pg_catalog.clock_timestamp()
            OR installation.absolute_expires_at <= pg_catalog.clock_timestamp()
          )
        ORDER BY session_set.absolute_expires_at, session_set.id
        FOR UPDATE OF session_set, installation SKIP LOCKED
        LIMIT p_limit
      LOOP
        DELETE FROM managed_auth_actor_mutation_leases
        WHERE session_set_id = set_row.id AND expires_at <= pg_catalog.clock_timestamp();
        IF EXISTS (
          SELECT 1 FROM managed_auth_actor_mutation_leases lease
          WHERE lease.session_set_id = set_row.id AND lease.expires_at > pg_catalog.clock_timestamp()
        ) THEN CONTINUE; END IF;
        DELETE FROM auth_sessions auth_session USING managed_auth_login_slots slot
        WHERE slot.session_set_id = set_row.id AND slot.status <> 'revoked'
          AND auth_session.id = slot.auth_session_id;
        UPDATE managed_auth_login_slots SET
          auth_session_id = NULL, status = 'revoked',
          revoked_at = coalesce(revoked_at, pg_catalog.clock_timestamp()),
          updated_at = pg_catalog.clock_timestamp()
        WHERE session_set_id = set_row.id AND status <> 'revoked';
        UPDATE managed_auth_session_sets SET
          revoked_at = coalesce(revoked_at, pg_catalog.clock_timestamp()),
          selected_slot_id = NULL, state = 'actor_change_required',
          updated_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.id;
        UPDATE managed_auth_browser_installations SET
          revoked_at = coalesce(revoked_at, pg_catalog.clock_timestamp()),
          last_seen_at = pg_catalog.clock_timestamp()
        WHERE id = set_row.installation_id;
        retired := retired + 1;
      END LOOP;
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RETURN retired;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config('opengeni.managed_auth_session_set_lifecycle', CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END, true);
      PERFORM pg_catalog.set_config('opengeni.canonical_human_identity_lifecycle', CASE WHEN previous_canonical_marker IS NULL THEN '' ELSE previous_canonical_marker END, true);
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  FOR data_schema IN SELECT current_schema() LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %I.get_canonical_human_exact_login_binding(text,text) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_authority_state(text) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_snapshot(text,text,boolean,boolean,boolean) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_bootstrap(text,text,text,text,uuid,text,bigint,bigint) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_begin_transaction(text,text,uuid,text,bigint,uuid,bigint,text,text,uuid,uuid,text,timestamptz) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_complete_transaction(text,text,uuid,text,bigint,bigint,uuid,text,text,text) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_mutate(text,text,uuid,text,bigint,bigint,text,uuid,uuid,uuid,text,text) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_actor_mutation_fence(text,bigint,uuid) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_actor_mutation_lease_acquire(text,bigint,uuid,integer) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_actor_mutation_lease_release(text,uuid) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_actor_mutation_lease_validate(text,bigint,uuid) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_adopted_session_snapshot(text) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_isolated_session_reap(integer) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_expired_session_set_reap(integer) FROM PUBLIC', data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.managed_auth_session_set_operation_receipt(text,uuid,text,text) FROM PUBLIC', data_schema);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.get_canonical_human_exact_login_binding(text,text) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_authority_state(text) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_snapshot(text,text,boolean,boolean,boolean) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_bootstrap(text,text,text,text,uuid,text,bigint,bigint) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_begin_transaction(text,text,uuid,text,bigint,uuid,bigint,text,text,uuid,uuid,text,timestamptz) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_complete_transaction(text,text,uuid,text,bigint,bigint,uuid,text,text,text) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_mutate(text,text,uuid,text,bigint,bigint,text,uuid,uuid,uuid,text,text) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_actor_mutation_fence(text,bigint,uuid) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_actor_mutation_lease_acquire(text,bigint,uuid,integer) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_actor_mutation_lease_release(text,uuid) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_actor_mutation_lease_validate(text,bigint,uuid) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_adopted_session_snapshot(text) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_isolated_session_reap(integer) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_expired_session_set_reap(integer) TO opengeni_app', data_schema);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.managed_auth_session_set_operation_receipt(text,uuid,text,text) TO opengeni_app', data_schema);
    END IF;
  END LOOP;
END
$managed_auth_session_set_routines$;

REVOKE ALL ON FUNCTION managed_auth_session_set_operations_append_only() FROM PUBLIC;

COMMENT ON TABLE "managed_auth_session_sets" IS
  'Hash-only browser installation/session-set authority with explicit generation and actor-epoch fences.';
COMMENT ON TABLE "managed_auth_login_slots" IS
  'Bounded provider-neutral login slots; references Better Auth sessions server-side and never duplicates their tokens.';
COMMENT ON TABLE "managed_auth_login_transactions" IS
  'One-use isolated add/reauth transactions; only SHA-256 secret digests are durable.';
COMMENT ON TABLE "managed_auth_session_set_operations" IS
  'Append-only, secret-free idempotency and security evidence for session-set mutations.';
