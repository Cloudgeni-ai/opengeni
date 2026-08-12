-- deployment-mode: rolling
-- Organization-independent canonical human identity and verified login-binding
-- authority. Identity never implies organization/workspace membership or
-- resource access. Mutations are lifecycle-only and revoke Better Auth sessions
-- in the same transaction that advances the monotonic auth revision.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "canonical_human_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "recovery_state" text NOT NULL DEFAULT 'ready',
  "identity_revision" bigint NOT NULL DEFAULT 1,
  "auth_revision" bigint NOT NULL DEFAULT 1,
  "active_login_binding_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canonical_human_identities_display_name_check" CHECK (
    length(btrim("display_name")) BETWEEN 1 AND 256
  ),
  CONSTRAINT "canonical_human_identities_status_check" CHECK (
    "status" IN ('active', 'recovery_required', 'disputed', 'disabled')
  ),
  CONSTRAINT "canonical_human_identities_recovery_state_check" CHECK (
    "recovery_state" IN ('ready', 'recovery_required', 'lost_factor', 'disputed', 'disabled')
  ),
  CONSTRAINT "canonical_human_identities_revision_check" CHECK (
    "identity_revision" > 0 AND "auth_revision" > 0
  ),
  CONSTRAINT "canonical_human_identities_state_check" CHECK (
    ("status" = 'active' AND "recovery_state" = 'ready')
    OR ("status" = 'recovery_required' AND "recovery_state" IN ('recovery_required', 'lost_factor'))
    OR ("status" = 'disputed' AND "recovery_state" = 'disputed')
    OR ("status" = 'disabled' AND "recovery_state" = 'disabled')
  )
);

CREATE TABLE "canonical_human_identity_subjects" (
  "auth_user_id" text PRIMARY KEY REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "identity_id" uuid NOT NULL REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "status" text NOT NULL DEFAULT 'active',
  "revision" bigint NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canonical_human_identity_subjects_user_check" CHECK (
    length(btrim("auth_user_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "canonical_human_identity_subjects_status_check" CHECK (
    "status" IN ('active', 'revoked')
  ),
  CONSTRAINT "canonical_human_identity_subjects_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "canonical_human_identity_subjects_identity_idx"
  ON "canonical_human_identity_subjects" ("identity_id", "status");

CREATE TABLE "canonical_human_login_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "identity_id" uuid NOT NULL REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "provider_id" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "revision" bigint NOT NULL DEFAULT 1,
  "verified_at" timestamptz NOT NULL DEFAULT now(),
  "last_verified_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canonical_human_login_bindings_provider_check" CHECK (
    "provider_id" = lower(btrim("provider_id"))
    AND length("provider_id") BETWEEN 1 AND 128
    AND "provider_id" ~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'
  ),
  CONSTRAINT "canonical_human_login_bindings_account_check" CHECK (
    length(btrim("provider_account_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "canonical_human_login_bindings_status_check" CHECK (
    "status" IN ('active', 'recovery_pending', 'stale', 'disputed', 'revoked')
  ),
  CONSTRAINT "canonical_human_login_bindings_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "canonical_human_login_bindings_revocation_check" CHECK (
    ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    OR ("status" <> 'revoked' AND "revoked_at" IS NULL)
  )
);
CREATE UNIQUE INDEX "canonical_human_login_bindings_provider_account_idx"
  ON "canonical_human_login_bindings" ("provider_id", "provider_account_id");
CREATE INDEX "canonical_human_login_bindings_identity_status_idx"
  ON "canonical_human_login_bindings" ("identity_id", "status", "created_at", "id");

ALTER TABLE "canonical_human_identities"
  ADD CONSTRAINT "canonical_human_identities_active_binding_fk"
  FOREIGN KEY ("active_login_binding_id")
  REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT;

CREATE TABLE "canonical_human_identity_operations" (
  "operation_id" uuid PRIMARY KEY,
  "identity_id" uuid NOT NULL REFERENCES "canonical_human_identities"("id") ON DELETE RESTRICT,
  "actor_auth_user_id" text NOT NULL REFERENCES "auth_users"("id") ON DELETE RESTRICT,
  "operation_type" text NOT NULL,
  "binding_id" uuid REFERENCES "canonical_human_login_bindings"("id") ON DELETE RESTRICT,
  "provider_id" text,
  "provider_account_id" text,
  "expected_identity_revision" bigint NOT NULL,
  "result_identity_revision" bigint NOT NULL,
  "result_auth_revision" bigint NOT NULL,
  "outcome" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "canonical_human_identity_operations_type_check" CHECK (
    "operation_type" IN ('link', 'unlink', 'begin_recovery', 'recover')
  ),
  CONSTRAINT "canonical_human_identity_operations_outcome_check" CHECK (
    "outcome" IN ('applied', 'lost_factor', 'disputed')
  ),
  CONSTRAINT "canonical_human_identity_operations_revision_check" CHECK (
    "expected_identity_revision" > 0
    AND "result_identity_revision" > 0
    AND "result_auth_revision" > 0
  ),
  CONSTRAINT "canonical_human_identity_operations_reason_check" CHECK (
    length(btrim("reason")) BETWEEN 1 AND 512
  )
);
CREATE INDEX "canonical_human_identity_operations_identity_created_idx"
  ON "canonical_human_identity_operations" ("identity_id", "created_at", "operation_id");

ALTER TABLE "auth_sessions"
  ADD COLUMN "identity_id" uuid,
  ADD COLUMN "identity_revision" bigint,
  ADD COLUMN "auth_revision" bigint;

DO $canonical_human_backfill$
DECLARE
  user_row record;
  identity_id uuid;
BEGIN
  FOR user_row IN
    SELECT id, name, email, created_at, updated_at
    FROM auth_users
    ORDER BY id
  LOOP
    INSERT INTO canonical_human_identities (
      display_name,
      created_at,
      updated_at
    ) VALUES (
      left(coalesce(nullif(btrim(user_row.name), ''), user_row.email), 256),
      user_row.created_at,
      user_row.updated_at
    )
    RETURNING id INTO identity_id;

    INSERT INTO canonical_human_identity_subjects (
      auth_user_id,
      identity_id,
      created_at,
      updated_at
    ) VALUES (
      user_row.id,
      identity_id,
      user_row.created_at,
      user_row.updated_at
    );
  END LOOP;

  INSERT INTO canonical_human_login_bindings (
    identity_id,
    provider_id,
    provider_account_id,
    verified_at,
    last_verified_at,
    created_at,
    updated_at
  )
  SELECT
    subject_row.identity_id,
    lower(identity_row.provider_id),
    identity_row.account_id,
    identity_row.created_at,
    greatest(identity_row.created_at, identity_row.updated_at),
    identity_row.created_at,
    identity_row.updated_at
  FROM auth_identities identity_row
  INNER JOIN canonical_human_identity_subjects subject_row
    ON subject_row.auth_user_id = identity_row.user_id
  ORDER BY identity_row.created_at, identity_row.id;

  UPDATE canonical_human_identities identity_row
  SET active_login_binding_id = (
    SELECT binding.id
    FROM canonical_human_login_bindings binding
    WHERE binding.identity_id = identity_row.id
      AND binding.status = 'active'
    ORDER BY binding.created_at, binding.id
    LIMIT 1
  );

  UPDATE auth_sessions session_row
  SET identity_id = subject_row.identity_id,
      identity_revision = identity_row.identity_revision,
      auth_revision = identity_row.auth_revision
  FROM canonical_human_identity_subjects subject_row
  INNER JOIN canonical_human_identities identity_row
    ON identity_row.id = subject_row.identity_id
  WHERE subject_row.auth_user_id = session_row.user_id
    AND subject_row.status = 'active';
END
$canonical_human_backfill$;

ALTER TABLE "auth_sessions"
  ALTER COLUMN "identity_id" SET NOT NULL,
  ALTER COLUMN "identity_revision" SET NOT NULL,
  ALTER COLUMN "auth_revision" SET NOT NULL,
  ADD CONSTRAINT "auth_sessions_canonical_identity_fk"
    FOREIGN KEY ("identity_id") REFERENCES "canonical_human_identities"("id") ON DELETE CASCADE,
  ADD CONSTRAINT "auth_sessions_canonical_identity_revision_check" CHECK (
    "identity_revision" > 0 AND "auth_revision" > 0
  );
CREATE INDEX "auth_sessions_identity_revision_idx"
  ON "auth_sessions" ("identity_id", "auth_revision", "identity_revision");

ALTER TABLE "canonical_human_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_identities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_identity_subjects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_identity_subjects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_login_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_login_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_identity_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "canonical_human_identity_operations" FORCE ROW LEVEL SECURITY;

CREATE POLICY canonical_human_identity_lifecycle ON "canonical_human_identities"
  USING (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active');
CREATE POLICY canonical_human_identity_lifecycle ON "canonical_human_identity_subjects"
  USING (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active');
CREATE POLICY canonical_human_identity_lifecycle ON "canonical_human_login_bindings"
  USING (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active');
CREATE POLICY canonical_human_identity_lifecycle ON "canonical_human_identity_operations"
  USING (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active')
  WITH CHECK (current_setting('opengeni.canonical_human_identity_lifecycle', true) = 'active');

DO $canonical_human_identity_routines$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.ensure_canonical_human_identity(
      p_auth_user_id text,
      p_display_name text
    )
    RETURNS TABLE (
      identity_id uuid,
      identity_revision bigint,
      auth_revision bigint,
      identity_status text
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      subject_row canonical_human_identity_subjects%%ROWTYPE;
      identity_row canonical_human_identities%%ROWTYPE;
      normalized_name text;
      stale_count integer;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_auth_user_id IS NULL
        OR p_auth_user_id <> pg_catalog.btrim(p_auth_user_id)
        OR pg_catalog.length(p_auth_user_id) NOT BETWEEN 1 AND 1024
      THEN
        RAISE EXCEPTION 'canonical human auth user is invalid' USING ERRCODE = '42501';
      END IF;
      normalized_name := pg_catalog.left(pg_catalog.btrim(p_display_name), 256);
      IF normalized_name IS NULL OR pg_catalog.length(normalized_name) < 1 THEN
        RAISE EXCEPTION 'canonical human display name is invalid' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM auth_users WHERE id = p_auth_user_id) THEN
        RAISE EXCEPTION 'canonical human auth user was not found' USING ERRCODE = 'P0002';
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('canonical-human-user:' || p_auth_user_id, 0)
      );
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );

      SELECT * INTO subject_row
      FROM canonical_human_identity_subjects
      WHERE auth_user_id = p_auth_user_id
      FOR UPDATE;

      IF NOT FOUND THEN
        INSERT INTO canonical_human_identities (display_name)
        VALUES (normalized_name)
        RETURNING * INTO identity_row;
        INSERT INTO canonical_human_identity_subjects (auth_user_id, identity_id)
        VALUES (p_auth_user_id, identity_row.id)
        RETURNING * INTO subject_row;
      ELSE
        IF subject_row.status <> 'active' THEN
          RAISE EXCEPTION 'canonical human subject is not active' USING ERRCODE = '42501';
        END IF;
        SELECT * INTO identity_row
        FROM canonical_human_identities
        WHERE id = subject_row.identity_id
        FOR UPDATE;
      END IF;

      IF identity_row.display_name IS DISTINCT FROM normalized_name THEN
        UPDATE canonical_human_identities AS renamed_identity
        SET display_name = normalized_name,
            identity_revision = renamed_identity.identity_revision + 1,
            updated_at = pg_catalog.clock_timestamp()
        WHERE renamed_identity.id = identity_row.id
        RETURNING * INTO identity_row;
      END IF;

      WITH stale AS (
        UPDATE canonical_human_login_bindings binding
        SET status = 'stale',
            revision = binding.revision + 1,
            updated_at = pg_catalog.clock_timestamp()
        WHERE binding.identity_id = identity_row.id
          AND binding.status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM auth_identities auth_identity
            WHERE auth_identity.user_id = p_auth_user_id
              AND lower(auth_identity.provider_id) = binding.provider_id
              AND auth_identity.account_id = binding.provider_account_id
          )
        RETURNING 1
      )
      SELECT count(*)::integer INTO stale_count FROM stale;

      IF stale_count > 0 THEN
        UPDATE canonical_human_identities AS stale_identity
        SET status = 'recovery_required',
            recovery_state = 'recovery_required',
            identity_revision = stale_identity.identity_revision + 1,
            auth_revision = stale_identity.auth_revision + 1,
            active_login_binding_id = (
              SELECT binding.id
              FROM canonical_human_login_bindings binding
              WHERE binding.identity_id = identity_row.id
                AND binding.status = 'active'
              ORDER BY binding.created_at, binding.id
              LIMIT 1
            ),
            updated_at = pg_catalog.clock_timestamp()
        WHERE stale_identity.id = identity_row.id
        RETURNING * INTO identity_row;
        DELETE FROM auth_sessions WHERE identity_id = identity_row.id;
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      identity_id := identity_row.id;
      identity_revision := identity_row.identity_revision;
      auth_revision := identity_row.auth_revision;
      identity_status := identity_row.status;
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.validate_canonical_human_session(
      p_auth_session_id text,
      p_auth_user_id text,
      p_allow_recovery boolean DEFAULT false
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      valid boolean;
      revisions_match boolean;
      current_status text;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );
      SELECT
        session_row.identity_revision = identity_row.identity_revision
          AND session_row.auth_revision = identity_row.auth_revision,
        identity_row.status
      INTO revisions_match, current_status
        FROM auth_sessions session_row
        INNER JOIN canonical_human_identity_subjects subject_row
          ON subject_row.auth_user_id = session_row.user_id
         AND subject_row.identity_id = session_row.identity_id
         AND subject_row.status = 'active'
        INNER JOIN canonical_human_identities identity_row
          ON identity_row.id = session_row.identity_id
        WHERE session_row.id = p_auth_session_id
          AND session_row.user_id = p_auth_user_id
          AND subject_row.status = 'active';
      valid := coalesce(revisions_match, false) AND (
        current_status = 'active'
        OR (p_allow_recovery AND current_status = 'recovery_required')
      );
      IF NOT valid AND (
        revisions_match IS DISTINCT FROM true
        OR current_status IS NULL
        OR current_status IN ('disputed', 'disabled')
      ) THEN
        DELETE FROM auth_sessions
        WHERE id = p_auth_session_id AND user_id = p_auth_user_id;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RETURN valid;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.get_canonical_human_identity_projection(
      p_auth_user_id text
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      result jsonb;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );
      SELECT pg_catalog.jsonb_build_object(
        'activeIdentity', pg_catalog.jsonb_build_object(
          'id', identity_row.id,
          'displayName', identity_row.display_name,
          'status', identity_row.status,
          'identityRevision', identity_row.identity_revision,
          'authRevision', identity_row.auth_revision,
          'activeLoginBindingId', identity_row.active_login_binding_id,
          'recoveryState', identity_row.recovery_state,
          'createdAt', pg_catalog.to_char(
            identity_row.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'updatedAt', pg_catalog.to_char(
            identity_row.updated_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )
        ),
        'loginBindings', coalesce((
          SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'id', binding.id,
              'providerId', binding.provider_id,
              'providerAccountId', binding.provider_account_id,
              'status', binding.status,
              'revision', binding.revision,
              'verifiedAt', pg_catalog.to_char(
                binding.verified_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'lastVerifiedAt', pg_catalog.to_char(
                binding.last_verified_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'revokedAt', pg_catalog.to_char(
                binding.revoked_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'createdAt', pg_catalog.to_char(
                binding.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'updatedAt', pg_catalog.to_char(
                binding.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            ) ORDER BY binding.created_at, binding.id
          )
          FROM canonical_human_login_bindings binding
          WHERE binding.identity_id = identity_row.id
        ), '[]'::jsonb)
      ) INTO result
      FROM canonical_human_identity_subjects subject_row
      INNER JOIN canonical_human_identities identity_row
        ON identity_row.id = subject_row.identity_id
      WHERE subject_row.auth_user_id = p_auth_user_id
        AND subject_row.status = 'active';
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RETURN result;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.apply_canonical_human_identity_operation(
      p_operation_id uuid,
      p_auth_user_id text,
      p_expected_identity_revision bigint,
      p_operation_type text,
      p_binding_id uuid,
      p_provider_id text,
      p_provider_account_id text,
      p_reason text
    )
    RETURNS TABLE (
      outcome text,
      identity_id uuid,
      identity_revision bigint,
      auth_revision bigint
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    DECLARE
      subject_row canonical_human_identity_subjects%%ROWTYPE;
      identity_row canonical_human_identities%%ROWTYPE;
      binding_row canonical_human_login_bindings%%ROWTYPE;
      prior_operation canonical_human_identity_operations%%ROWTYPE;
      normalized_provider text;
      active_count integer;
      replacement_binding_id uuid;
      previous_marker text := pg_catalog.current_setting(
        'opengeni.canonical_human_identity_lifecycle', true
      );
    BEGIN
      IF p_operation_id IS NULL
        OR p_expected_identity_revision IS NULL
        OR p_expected_identity_revision < 1
        OR p_operation_type NOT IN ('link', 'unlink', 'begin_recovery', 'recover')
        OR p_reason IS NULL
        OR p_reason <> pg_catalog.btrim(p_reason)
        OR pg_catalog.length(p_reason) NOT BETWEEN 1 AND 512
      THEN
        RAISE EXCEPTION 'canonical human identity operation is invalid' USING ERRCODE = '22023';
      END IF;
      normalized_provider := lower(pg_catalog.btrim(p_provider_id));
      IF p_operation_type = 'link' AND (
        normalized_provider IS NULL
        OR pg_catalog.length(normalized_provider) NOT BETWEEN 1 AND 128
        OR normalized_provider !~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'
        OR p_provider_account_id IS NULL
        OR p_provider_account_id <> pg_catalog.btrim(p_provider_account_id)
        OR pg_catalog.length(p_provider_account_id) NOT BETWEEN 1 AND 1024
      ) THEN
        RAISE EXCEPTION 'canonical human login binding is invalid' USING ERRCODE = '22023';
      END IF;
      IF p_operation_type <> 'link' AND p_binding_id IS NULL THEN
        RAISE EXCEPTION 'canonical human login binding id is required' USING ERRCODE = '22023';
      END IF;

      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle', 'active', true
      );
      SELECT * INTO prior_operation
      FROM canonical_human_identity_operations
      WHERE operation_id = p_operation_id;
      IF FOUND THEN
        IF prior_operation.actor_auth_user_id IS DISTINCT FROM p_auth_user_id
          OR prior_operation.operation_type IS DISTINCT FROM p_operation_type
          OR prior_operation.binding_id IS DISTINCT FROM p_binding_id
          OR prior_operation.provider_id IS DISTINCT FROM normalized_provider
          OR prior_operation.provider_account_id IS DISTINCT FROM p_provider_account_id
          OR prior_operation.expected_identity_revision IS DISTINCT FROM p_expected_identity_revision
          OR prior_operation.reason IS DISTINCT FROM p_reason
        THEN
          RAISE EXCEPTION 'canonical human operation id was reused' USING ERRCODE = '23505';
        END IF;
        outcome := prior_operation.outcome;
        identity_id := prior_operation.identity_id;
        identity_revision := prior_operation.result_identity_revision;
        auth_revision := prior_operation.result_auth_revision;
        PERFORM pg_catalog.set_config(
          'opengeni.canonical_human_identity_lifecycle',
          CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
          true
        );
        RETURN NEXT;
        RETURN;
      END IF;

      SELECT * INTO subject_row
      FROM canonical_human_identity_subjects
      WHERE auth_user_id = p_auth_user_id
        AND status = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'canonical human subject was not found' USING ERRCODE = 'P0002';
      END IF;
      SELECT * INTO identity_row
      FROM canonical_human_identities
      WHERE id = subject_row.identity_id
      FOR UPDATE;
      IF identity_row.identity_revision <> p_expected_identity_revision THEN
        RAISE EXCEPTION 'canonical human identity revision conflict' USING ERRCODE = '40001';
      END IF;
      IF identity_row.status IN ('disputed', 'disabled') THEN
        RAISE EXCEPTION 'canonical human identity is not mutable' USING ERRCODE = '42501';
      END IF;
      IF p_operation_type = 'link' AND identity_row.status = 'recovery_required' THEN
        RAISE EXCEPTION 'canonical human identity requires explicit recovery completion'
          USING ERRCODE = '42501';
      END IF;

      IF p_operation_type = 'link' THEN
        IF NOT EXISTS (
          SELECT 1 FROM auth_identities
          WHERE user_id = p_auth_user_id
            AND lower(provider_id) = normalized_provider
            AND account_id = p_provider_account_id
        ) THEN
          RAISE EXCEPTION 'login binding is not verified by the authentication provider'
            USING ERRCODE = '42501';
        END IF;
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'canonical-human-binding:' || normalized_provider || ':' || p_provider_account_id,
            0
          )
        );
        SELECT * INTO binding_row
        FROM canonical_human_login_bindings
        WHERE provider_id = normalized_provider
          AND provider_account_id = p_provider_account_id
        FOR UPDATE;
        IF FOUND AND binding_row.identity_id <> identity_row.id THEN
          UPDATE canonical_human_login_bindings
          SET status = 'disputed',
              revision = revision + 1,
              revoked_at = NULL,
              updated_at = pg_catalog.clock_timestamp()
          WHERE id = binding_row.id;
          UPDATE canonical_human_identities AS disputed_identity
          SET status = 'disputed',
              recovery_state = 'disputed',
              identity_revision = disputed_identity.identity_revision + 1,
              auth_revision = disputed_identity.auth_revision + 1,
              updated_at = pg_catalog.clock_timestamp()
          WHERE disputed_identity.id IN (identity_row.id, binding_row.identity_id);
          DELETE FROM auth_sessions AS disputed_session
          WHERE disputed_session.identity_id IN (identity_row.id, binding_row.identity_id);
          SELECT * INTO identity_row
          FROM canonical_human_identities WHERE id = identity_row.id;
          outcome := 'disputed';
        ELSE
          IF NOT FOUND THEN
            INSERT INTO canonical_human_login_bindings (
              identity_id, provider_id, provider_account_id
            ) VALUES (
              identity_row.id, normalized_provider, p_provider_account_id
            ) RETURNING * INTO binding_row;
          ELSE
            UPDATE canonical_human_login_bindings
            SET status = 'active',
                revision = revision + 1,
                last_verified_at = pg_catalog.clock_timestamp(),
                revoked_at = NULL,
                updated_at = pg_catalog.clock_timestamp()
            WHERE id = binding_row.id
            RETURNING * INTO binding_row;
          END IF;
          UPDATE canonical_human_identities AS linked_identity
          SET status = 'active',
              recovery_state = 'ready',
              active_login_binding_id = binding_row.id,
              identity_revision = linked_identity.identity_revision + 1,
              auth_revision = linked_identity.auth_revision + 1,
              updated_at = pg_catalog.clock_timestamp()
          WHERE linked_identity.id = identity_row.id
          RETURNING * INTO identity_row;
          DELETE FROM auth_sessions AS linked_session
          WHERE linked_session.identity_id = identity_row.id;
          outcome := 'applied';
        END IF;
      ELSE
        SELECT * INTO binding_row
        FROM canonical_human_login_bindings AS requested_binding
        WHERE requested_binding.id = p_binding_id
          AND requested_binding.identity_id = identity_row.id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'canonical human login binding was not found' USING ERRCODE = 'P0002';
        END IF;

        IF p_operation_type = 'unlink' THEN
          SELECT count(*)::integer INTO active_count
          FROM canonical_human_login_bindings AS remaining_binding
          WHERE remaining_binding.identity_id = identity_row.id
            AND remaining_binding.status = 'active'
            AND remaining_binding.id <> binding_row.id;
          IF active_count < 1 THEN
            UPDATE canonical_human_login_bindings
            SET status = 'recovery_pending',
                revision = revision + 1,
                updated_at = pg_catalog.clock_timestamp()
            WHERE id = binding_row.id;
            UPDATE canonical_human_identities AS lost_factor_identity
            SET status = 'recovery_required',
                recovery_state = 'lost_factor',
                active_login_binding_id = NULL,
                identity_revision = lost_factor_identity.identity_revision + 1,
                auth_revision = lost_factor_identity.auth_revision + 1,
                updated_at = pg_catalog.clock_timestamp()
            WHERE lost_factor_identity.id = identity_row.id
            RETURNING * INTO identity_row;
            outcome := 'lost_factor';
          ELSE
            DELETE FROM auth_identities
            WHERE user_id = p_auth_user_id
              AND lower(provider_id) = binding_row.provider_id
              AND account_id = binding_row.provider_account_id;
            UPDATE canonical_human_login_bindings
            SET status = 'revoked',
                revision = revision + 1,
                revoked_at = pg_catalog.clock_timestamp(),
                updated_at = pg_catalog.clock_timestamp()
            WHERE id = binding_row.id;
            SELECT replacement_binding.id INTO replacement_binding_id
            FROM canonical_human_login_bindings AS replacement_binding
            WHERE replacement_binding.identity_id = identity_row.id
              AND replacement_binding.status = 'active'
            ORDER BY replacement_binding.created_at, replacement_binding.id LIMIT 1;
            UPDATE canonical_human_identities AS unlinked_identity
            SET active_login_binding_id = replacement_binding_id,
                identity_revision = unlinked_identity.identity_revision + 1,
                auth_revision = unlinked_identity.auth_revision + 1,
                updated_at = pg_catalog.clock_timestamp()
            WHERE unlinked_identity.id = identity_row.id
            RETURNING * INTO identity_row;
            outcome := 'applied';
          END IF;
        ELSIF p_operation_type = 'begin_recovery' THEN
          UPDATE canonical_human_login_bindings
          SET status = 'recovery_pending',
              revision = revision + 1,
              updated_at = pg_catalog.clock_timestamp()
          WHERE id = binding_row.id;
          UPDATE canonical_human_identities AS recovering_identity
          SET status = 'recovery_required',
              recovery_state = 'recovery_required',
              active_login_binding_id = NULL,
              identity_revision = recovering_identity.identity_revision + 1,
              auth_revision = recovering_identity.auth_revision + 1,
              updated_at = pg_catalog.clock_timestamp()
          WHERE recovering_identity.id = identity_row.id
          RETURNING * INTO identity_row;
          outcome := 'applied';
        ELSE
          IF NOT EXISTS (
            SELECT 1 FROM auth_identities
            WHERE user_id = p_auth_user_id
              AND lower(provider_id) = binding_row.provider_id
              AND account_id = binding_row.provider_account_id
          ) THEN
            RAISE EXCEPTION 'login binding has not been reverified'
              USING ERRCODE = '42501';
          END IF;
          UPDATE canonical_human_login_bindings
          SET status = 'active',
              revision = revision + 1,
              last_verified_at = pg_catalog.clock_timestamp(),
              revoked_at = NULL,
              updated_at = pg_catalog.clock_timestamp()
          WHERE id = binding_row.id;
          UPDATE canonical_human_identities AS recovered_identity
          SET status = 'active',
              recovery_state = 'ready',
              active_login_binding_id = binding_row.id,
              identity_revision = recovered_identity.identity_revision + 1,
              auth_revision = recovered_identity.auth_revision + 1,
              updated_at = pg_catalog.clock_timestamp()
          WHERE recovered_identity.id = identity_row.id
          RETURNING * INTO identity_row;
          outcome := 'applied';
        END IF;
        DELETE FROM auth_sessions AS invalidated_session
        WHERE invalidated_session.identity_id = identity_row.id;
      END IF;

      INSERT INTO canonical_human_identity_operations (
        operation_id,
        identity_id,
        actor_auth_user_id,
        operation_type,
        binding_id,
        provider_id,
        provider_account_id,
        expected_identity_revision,
        result_identity_revision,
        result_auth_revision,
        outcome,
        reason
      ) VALUES (
        p_operation_id,
        identity_row.id,
        p_auth_user_id,
        p_operation_type,
        CASE WHEN p_operation_type = 'link' THEN binding_row.id ELSE p_binding_id END,
        CASE WHEN p_operation_type = 'link' THEN normalized_provider ELSE NULL END,
        CASE WHEN p_operation_type = 'link' THEN p_provider_account_id ELSE NULL END,
        p_expected_identity_revision,
        identity_row.identity_revision,
        identity_row.auth_revision,
        outcome,
        p_reason
      );

      identity_id := identity_row.id;
      identity_revision := identity_row.identity_revision;
      auth_revision := identity_row.auth_revision;
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RETURN NEXT;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.canonical_human_identity_lifecycle',
        CASE WHEN previous_marker IS NULL THEN '' ELSE previous_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.ensure_canonical_human_identity(text,text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.validate_canonical_human_session(text,text,boolean) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.get_canonical_human_identity_projection(text) FROM PUBLIC',
    data_schema
  );
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.apply_canonical_human_identity_operation(uuid,text,bigint,text,uuid,text,text,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.ensure_canonical_human_identity(text,text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.validate_canonical_human_session(text,text,boolean) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.get_canonical_human_identity_projection(text) TO opengeni_app',
      data_schema
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.apply_canonical_human_identity_operation(uuid,text,bigint,text,uuid,text,text,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$canonical_human_identity_routines$;

COMMENT ON TABLE "canonical_human_identities" IS
  'Organization-independent canonical human identity; never organization or workspace authority.';
COMMENT ON TABLE "canonical_human_login_bindings" IS
  'Verified provider/account login bindings with deterministic recovery, dispute, stale, and revocation states.';
COMMENT ON TABLE "canonical_human_identity_operations" IS
  'Append-only identity lifecycle audit and idempotency ledger; contains no organization or resource metadata.';
COMMENT ON COLUMN "auth_sessions"."auth_revision" IS
  'Canonical-human authentication fence stamped at session creation; mismatch invalidates the session immediately.';