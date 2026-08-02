-- deployment-mode: rolling
-- Freeze the exact active workspace charter/policies and typed policy role for
-- every accepted attempt. Documents and knowledge sources are not policy
-- authorities and are intentionally absent from this snapshot.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "policy_role" text;

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_policy_role_chk" CHECK (
    "policy_role" IS NULL
    OR (
      "policy_role" = lower(btrim("policy_role"))
      AND length("policy_role") BETWEEN 1 AND 64
      AND "policy_role" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "policy_role" !~ '--'
    )
  );

CREATE OR REPLACE FUNCTION workspace_instruction_policy_reject_session_role_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."policy_role" IS DISTINCT FROM OLD."policy_role" THEN
    RAISE EXCEPTION 'session policy role is immutable after creation'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sessions_policy_role_immutable ON "sessions";
CREATE TRIGGER sessions_policy_role_immutable
  BEFORE UPDATE OF "policy_role" ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_reject_session_role_mutation();

ALTER TABLE "session_turns"
  ADD COLUMN IF NOT EXISTS "initiating_human_subject_id" text;

ALTER TABLE "session_turns"
  ADD CONSTRAINT "session_turns_initiating_human_subject_id_chk" CHECK (
    "initiating_human_subject_id" IS NULL
    OR length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
  );

CREATE OR REPLACE FUNCTION workspace_governance_reject_turn_human_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."initiating_human_subject_id" IS DISTINCT FROM OLD."initiating_human_subject_id" THEN
    RAISE EXCEPTION 'turn initiating human is immutable after acceptance'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_turns_initiating_human_immutable ON "session_turns";
CREATE TRIGGER session_turns_initiating_human_immutable
  BEFORE UPDATE OF "initiating_human_subject_id" ON "session_turns"
  FOR EACH ROW EXECUTE FUNCTION workspace_governance_reject_turn_human_mutation();

ALTER TABLE "preference_registry_snapshots"
  DROP CONSTRAINT "preference_registry_snapshots_account_id_fkey",
  ADD CONSTRAINT "preference_registry_snapshots_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  DROP CONSTRAINT "preference_registry_snapshots_workspace_id_fkey",
  ADD CONSTRAINT "preference_registry_snapshots_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
  DROP CONSTRAINT "preference_registry_snapshots_session_id_fkey",
  ADD CONSTRAINT "preference_registry_snapshots_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE,
  DROP CONSTRAINT "preference_registry_snapshots_turn_id_fkey",
  ADD CONSTRAINT "preference_registry_snapshots_turn_id_fkey"
    FOREIGN KEY ("turn_id") REFERENCES "session_turns"("id") ON DELETE CASCADE,
  DROP CONSTRAINT "preference_registry_snapshots_attempt_id_fkey",
  ADD CONSTRAINT "preference_registry_snapshots_attempt_id_fkey"
    FOREIGN KEY ("attempt_id") REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE;

CREATE TABLE "workspace_instruction_policy_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE,
  "execution_generation" integer NOT NULL,
  "policy_role" text,
  "role_source" text NOT NULL,
  "entries" jsonb NOT NULL,
  "entry_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_instruction_policy_snapshots_generation_chk" CHECK (
    "execution_generation" > 0
  ),
  CONSTRAINT "workspace_instruction_policy_snapshots_entries_chk" CHECK (
    jsonb_typeof("entries") = 'array'
    AND jsonb_array_length("entries") <= 3
  ),
  CONSTRAINT "workspace_instruction_policy_snapshots_hash_chk" CHECK (
    "entry_hash" ~ '^[0-9a-f]{64}$'
    AND "entry_hash" = encode(sha256(convert_to("entries"::text, 'UTF8')), 'hex')
  ),
  CONSTRAINT "workspace_instruction_policy_snapshots_role_source_chk" CHECK (
    "role_source" IN (
      'session_binding',
      'metadata_fallback',
      'none',
      'invalid_metadata_fallback'
    )
  ),
  CONSTRAINT "workspace_instruction_policy_snapshots_role_shape_chk" CHECK (
    (
      "role_source" IN ('session_binding', 'metadata_fallback')
      AND "policy_role" IS NOT NULL
      AND "policy_role" = lower(btrim("policy_role"))
      AND length("policy_role") BETWEEN 1 AND 64
      AND "policy_role" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND "policy_role" !~ '--'
    )
    OR (
      "role_source" IN ('none', 'invalid_metadata_fallback')
      AND "policy_role" IS NULL
    )
  ),
  CONSTRAINT "workspace_instruction_policy_snapshots_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "attempt_id")
);

CREATE INDEX "workspace_instruction_policy_snapshots_workspace_time_idx"
  ON "workspace_instruction_policy_snapshots" ("workspace_id", "created_at" DESC, "id");

CREATE OR REPLACE FUNCTION workspace_instruction_policy_normalize_role_key(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT lower(
    regexp_replace(
      regexp_replace(btrim(normalize(value, NFKC)), '[[:space:]]+', '-', 'g'),
      '-+',
      '-',
      'g'
    )
  );
$$;

REVOKE ALL ON FUNCTION workspace_instruction_policy_normalize_role_key(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION workspace_instruction_policy_canonical_snapshot_entries(
  p_account_id uuid,
  p_workspace_id uuid,
  p_policy_role text,
  p_accepted_at timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(jsonb_agg(candidate.entry ORDER BY candidate.ordinal), '[]'::jsonb)
  FROM (
    SELECT
      CASE
        WHEN event.kind = 'charter' THEN 0
        WHEN event.scope = 'global' THEN 1
        ELSE 2
      END AS ordinal,
      jsonb_build_object(
        'kind', event.kind,
        'scope', event.scope,
        'roleKey', event.role_key,
        'revisionId', revision.id::text,
        'revision', revision.revision,
        'contentHash', revision.content_hash,
        'activationVersion', event.activation_version,
        'activatedAt', to_char(
          event.created_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'provenance', jsonb_build_object(
          'source', revision.provenance_source,
          'sourceIdHash', CASE
            WHEN revision.provenance_source_id IS NULL THEN NULL
            ELSE encode(
              sha256(convert_to(revision.provenance_source_id, 'UTF8')),
              'hex'
            )
          END
        )
      ) AS entry
    FROM (
      SELECT DISTINCT ON (activation.kind, activation.scope, coalesce(activation.role_key, ''))
        activation.*
      FROM workspace_instruction_policy_activation_events activation
      WHERE activation.account_id = p_account_id
        AND activation.workspace_id = p_workspace_id
        AND activation.created_at <= p_accepted_at
        AND (
          (activation.kind = 'charter' AND activation.scope = 'global')
          OR (activation.kind = 'policy' AND activation.scope = 'global')
          OR (
            p_policy_role IS NOT NULL
            AND activation.kind = 'policy'
            AND activation.scope = 'role'
            AND activation.role_key = p_policy_role
          )
        )
      ORDER BY
        activation.kind,
        activation.scope,
        coalesce(activation.role_key, ''),
        activation.created_at DESC,
        activation.activation_version DESC,
        activation.id DESC
    ) event
    JOIN workspace_instruction_policy_revisions revision
      ON revision.account_id = event.account_id
      AND revision.workspace_id = event.workspace_id
      AND revision.id = event.new_revision_id
      AND revision.revision = event.new_revision
      AND revision.content_hash = event.new_content_hash
  ) candidate;
$$;

REVOKE ALL ON FUNCTION workspace_instruction_policy_canonical_snapshot_entries(
  uuid,
  uuid,
  text,
  timestamptz
)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION workspace_instruction_policy_validate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_policy_role text;
  session_metadata jsonb;
  metadata_role_present boolean;
  metadata_role_candidate text;
  canonical_policy_role text;
  canonical_role_source text;
  canonical_entries jsonb;
  turn_accepted_at timestamptz;
BEGIN
  SELECT session.policy_role, session.metadata, turn.created_at
    INTO session_policy_role, session_metadata, turn_accepted_at
  FROM session_turn_attempts attempt
  JOIN session_turns turn
    ON turn.account_id = attempt.account_id
    AND turn.workspace_id = attempt.workspace_id
    AND turn.session_id = attempt.session_id
    AND turn.id = attempt.turn_id
  JOIN sessions session
    ON session.account_id = attempt.account_id
    AND session.workspace_id = attempt.workspace_id
    AND session.id = attempt.session_id
  WHERE attempt.id = NEW.attempt_id
    AND attempt.account_id = NEW.account_id
    AND attempt.workspace_id = NEW.workspace_id
    AND attempt.session_id = NEW.session_id
    AND attempt.turn_id = NEW.turn_id
    AND attempt.execution_generation = NEW.execution_generation
    AND turn.execution_generation = NEW.execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND turn.active_attempt_id = attempt.id
    AND session.active_turn_id = turn.id
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND NOT EXISTS (
      SELECT 1
      FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = NEW.workspace_id
        AND interruption.attempt_id = NEW.attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'instruction-policy snapshot requires an exact active attempt'
      USING ERRCODE = '23514';
  END IF;

  IF session_policy_role IS NOT NULL THEN
    canonical_policy_role := session_policy_role;
    canonical_role_source := 'session_binding';
  ELSE
    metadata_role_present := coalesce(session_metadata ? 'role', false);
    IF metadata_role_present AND jsonb_typeof(session_metadata->'role') = 'string' THEN
      metadata_role_candidate := workspace_instruction_policy_normalize_role_key(
        session_metadata->>'role'
      );
    END IF;
    IF metadata_role_candidate IS NOT NULL
      AND length(metadata_role_candidate) BETWEEN 1 AND 64
      AND metadata_role_candidate ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
      AND metadata_role_candidate !~ '--'
    THEN
      canonical_policy_role := metadata_role_candidate;
      canonical_role_source := 'metadata_fallback';
    ELSIF metadata_role_present THEN
      canonical_policy_role := NULL;
      canonical_role_source := 'invalid_metadata_fallback';
    ELSE
      canonical_policy_role := NULL;
      canonical_role_source := 'none';
    END IF;
  END IF;

  IF NEW.policy_role IS DISTINCT FROM canonical_policy_role
    OR NEW.role_source IS DISTINCT FROM canonical_role_source
  THEN
    RAISE EXCEPTION 'instruction-policy snapshot role does not match the immutable session binding'
      USING ERRCODE = '23514';
  END IF;

  canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
    NEW.account_id,
    NEW.workspace_id,
    canonical_policy_role,
    turn_accepted_at
  );
  IF NEW.entries IS DISTINCT FROM canonical_entries
    OR NEW.entry_hash IS DISTINCT FROM encode(
      sha256(convert_to(canonical_entries::text, 'UTF8')),
      'hex'
    )
  THEN
    RAISE EXCEPTION 'instruction-policy snapshot is not the canonical locked policy set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_snapshots_validate
  ON "workspace_instruction_policy_snapshots";
CREATE TRIGGER workspace_instruction_policy_snapshots_validate
  BEFORE INSERT ON "workspace_instruction_policy_snapshots"
  FOR EACH ROW EXECUTE FUNCTION workspace_instruction_policy_validate_snapshot();

CREATE OR REPLACE FUNCTION workspace_governance_snapshot_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent lifecycle deletion is the sole mutation exception. PostgreSQL's
  -- cascading constraint trigger runs only after its parent row is absent;
  -- require both that nested trigger context and one missing ownership edge so
  -- direct or unrelated-trigger deletes remain fail-closed.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM "managed_accounts" WHERE "id" = OLD."account_id")
      OR NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id")
      OR NOT EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."session_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turns" WHERE "id" = OLD."turn_id")
      OR NOT EXISTS (SELECT 1 FROM "session_turn_attempts" WHERE "id" = OLD."attempt_id")
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'accepted-turn governance snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS workspace_instruction_policy_snapshots_immutable
  ON "workspace_instruction_policy_snapshots";
CREATE TRIGGER workspace_instruction_policy_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "workspace_instruction_policy_snapshots"
  FOR EACH ROW EXECUTE FUNCTION workspace_governance_snapshot_reject_mutation();

DROP TRIGGER IF EXISTS preference_registry_snapshots_immutable
  ON "preference_registry_snapshots";
CREATE TRIGGER preference_registry_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "preference_registry_snapshots"
  FOR EACH ROW EXECUTE FUNCTION workspace_governance_snapshot_reject_mutation();

DO $snapshot_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.workspace_instruction_policy_get_or_create_snapshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS SETOF %I.workspace_instruction_policy_snapshots
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      session_policy_role text;
      session_metadata jsonb;
      metadata_role_present boolean;
      metadata_role_candidate text;
      canonical_policy_role text;
      canonical_role_source text;
      canonical_entries jsonb;
      canonical_hash text;
      turn_accepted_at timestamptz;
      snapshot_time timestamptz := transaction_timestamp();
      winner_id uuid;
    BEGIN
      context_account_id := NULLIF(
        current_setting('opengeni.account_id', true), ''
      )::uuid;
      context_workspace_id := NULLIF(
        current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR p_execution_generation < 1
      THEN
        RAISE EXCEPTION 'instruction-policy snapshot requires exact transaction-local tenant authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT session.policy_role, session.metadata, turn.created_at
        INTO session_policy_role, session_metadata, turn_accepted_at
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id
        AND session.workspace_id = workspace.id
      JOIN session_turns turn
        ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn.account_id
        AND attempt.workspace_id = turn.workspace_id
        AND attempt.session_id = turn.session_id
        AND attempt.turn_id = turn.id
      WHERE workspace.id = p_workspace_id
        AND workspace.account_id = p_account_id
        AND session.id = p_session_id
        AND session.active_turn_id = p_turn_id
        AND turn.id = p_turn_id
        AND turn.active_attempt_id = p_attempt_id
        AND turn.execution_generation = p_execution_generation
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt.id = p_attempt_id
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'instruction-policy snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;

      SELECT snapshot.id INTO winner_id
      FROM workspace_instruction_policy_snapshots snapshot
      WHERE snapshot.account_id = p_account_id
        AND snapshot.workspace_id = p_workspace_id
        AND snapshot.session_id = p_session_id
        AND snapshot.turn_id = p_turn_id
        AND snapshot.attempt_id = p_attempt_id
        AND snapshot.execution_generation = p_execution_generation
      FOR SHARE;
      IF winner_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1
          FROM workspace_instruction_policy_snapshots snapshot
          WHERE snapshot.id = winner_id
            AND (
              snapshot.created_at > transaction_timestamp()
              OR jsonb_typeof(snapshot.entries) <> 'array'
              OR jsonb_array_length(snapshot.entries) > 3
              OR snapshot.entry_hash IS DISTINCT FROM encode(
                sha256(convert_to(snapshot.entries::text, 'UTF8')),
                'hex'
              )
              OR (
                snapshot.role_source IN ('session_binding', 'metadata_fallback')
                AND snapshot.policy_role IS NULL
              )
              OR (
                snapshot.role_source IN ('none', 'invalid_metadata_fallback')
                AND snapshot.policy_role IS NOT NULL
              )
            )
        ) THEN
          RAISE EXCEPTION 'existing instruction-policy snapshot failed canonical integrity checks'
            USING ERRCODE = '23514';
        END IF;
        RETURN QUERY
        SELECT snapshot.*
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.id = winner_id;
        RETURN;
      END IF;

      IF session_policy_role IS NOT NULL THEN
        canonical_policy_role := session_policy_role;
        canonical_role_source := 'session_binding';
      ELSE
        metadata_role_present := coalesce(session_metadata ? 'role', false);
        IF metadata_role_present AND jsonb_typeof(session_metadata->'role') = 'string' THEN
          metadata_role_candidate := workspace_instruction_policy_normalize_role_key(
            session_metadata->>'role'
          );
        END IF;
        IF metadata_role_candidate IS NOT NULL
          AND length(metadata_role_candidate) BETWEEN 1 AND 64
          AND metadata_role_candidate ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
          AND metadata_role_candidate !~ '--'
        THEN
          canonical_policy_role := metadata_role_candidate;
          canonical_role_source := 'metadata_fallback';
        ELSIF metadata_role_present THEN
          canonical_policy_role := NULL;
          canonical_role_source := 'invalid_metadata_fallback';
        ELSE
          canonical_policy_role := NULL;
          canonical_role_source := 'none';
        END IF;
      END IF;

      PERFORM 1
      FROM workspace_instruction_policy_activation_events event
      WHERE event.account_id = p_account_id
        AND event.workspace_id = p_workspace_id
        AND event.created_at <= turn_accepted_at
        AND (
          (event.kind = 'charter' AND event.scope = 'global')
          OR (event.kind = 'policy' AND event.scope = 'global')
          OR (
            canonical_policy_role IS NOT NULL
            AND event.kind = 'policy'
            AND event.scope = 'role'
            AND event.role_key = canonical_policy_role
          )
        )
      ORDER BY CASE
        WHEN event.kind = 'charter' THEN 0
        WHEN event.scope = 'global' THEN 1
        ELSE 2
      END,
      event.created_at,
      event.activation_version
      FOR SHARE OF event;

      canonical_entries := workspace_instruction_policy_canonical_snapshot_entries(
        p_account_id,
        p_workspace_id,
        canonical_policy_role,
        turn_accepted_at
      );
      canonical_hash := encode(
        sha256(convert_to(canonical_entries::text, 'UTF8')),
        'hex'
      );

      INSERT INTO workspace_instruction_policy_snapshots (
        account_id,
        workspace_id,
        session_id,
        turn_id,
        attempt_id,
        execution_generation,
        policy_role,
        role_source,
        entries,
        entry_hash,
        created_at
      ) VALUES (
        p_account_id,
        p_workspace_id,
        p_session_id,
        p_turn_id,
        p_attempt_id,
        p_execution_generation,
        canonical_policy_role,
        canonical_role_source,
        canonical_entries,
        canonical_hash,
        snapshot_time
      )
      ON CONFLICT (account_id, workspace_id, attempt_id) DO NOTHING
      RETURNING id INTO winner_id;
      IF winner_id IS NULL THEN
        SELECT snapshot.id INTO winner_id
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.account_id = p_account_id
          AND snapshot.workspace_id = p_workspace_id
          AND snapshot.session_id = p_session_id
          AND snapshot.turn_id = p_turn_id
          AND snapshot.attempt_id = p_attempt_id
          AND snapshot.execution_generation = p_execution_generation
        FOR SHARE;
      END IF;
      IF winner_id IS NULL THEN
        RAISE EXCEPTION 'instruction-policy snapshot winner conflicts with exact attempt authority'
          USING ERRCODE = '40001';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM workspace_instruction_policy_snapshots snapshot
        WHERE snapshot.id = winner_id
          AND (
            snapshot.policy_role IS DISTINCT FROM canonical_policy_role
            OR snapshot.role_source IS DISTINCT FROM canonical_role_source
            OR snapshot.entries IS DISTINCT FROM canonical_entries
            OR snapshot.entry_hash IS DISTINCT FROM canonical_hash
            OR snapshot.created_at IS DISTINCT FROM snapshot_time
          )
      ) THEN
        RAISE EXCEPTION 'instruction-policy snapshot winner is not the canonical locked snapshot'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY
      SELECT snapshot.*
      FROM workspace_instruction_policy_snapshots snapshot
      WHERE snapshot.id = winner_id;
    END
    $body$
  $ddl$, target_schema, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.workspace_instruction_policy_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.workspace_instruction_policy_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END $snapshot_function$;

ALTER TABLE "workspace_instruction_policy_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspace_instruction_policy_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "workspace_instruction_policy_snapshots"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $runtime_grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.workspace_instruction_policy_snapshots FROM opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.workspace_instruction_policy_snapshots TO opengeni_app',
      target_schema
    );
  END IF;
END $runtime_grants$;

-- The structured preference registry remains the sole preference authority.
-- This migration changes only the accepted-attempt delivery boundary by
-- reconstructing the exact active descriptor set from immutable lifecycle
-- events at the turn's acceptance timestamp.
CREATE OR REPLACE FUNCTION preference_registry_canonical_snapshot_at(
  p_account_id uuid,
  p_workspace_id uuid,
  p_initiating_human_subject_id text,
  p_accepted_at timestamptz
) RETURNS TABLE (canonical_descriptors jsonb, canonical_truncated boolean)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  canonical_descriptor jsonb;
  candidate_descriptors jsonb;
BEGIN
  canonical_descriptors := '[]'::jsonb;
  canonical_truncated := false;

  FOR canonical_descriptor IN
    WITH state_event AS (
      SELECT DISTINCT ON (event.preference_id)
        event.preference_id,
        event.type,
        event.new_revision_id
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.type IN (
          'proposal_created',
          'activated',
          'corrected',
          'rejected',
          'deactivated',
          'superseded'
        )
      ORDER BY
        event.preference_id,
        event.created_at DESC,
        event.version DESC,
        event.id DESC
    ), scope_event AS (
      SELECT DISTINCT ON (event.preference_id)
        event.preference_id,
        event.new_scope AS scope,
        event.new_workspace_id AS scope_workspace_id,
        event.new_subject_id AS scope_subject_id
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.new_scope IS NOT NULL
      ORDER BY
        event.preference_id,
        event.created_at DESC,
        event.version DESC,
        event.id DESC
    ), activation_version AS (
      SELECT
        event.preference_id,
        count(*)::integer AS value
      FROM preference_registry_events event
      WHERE event.account_id = p_account_id
        AND event.created_at <= p_accepted_at
        AND event.type IN ('activated', 'corrected', 'deactivated')
      GROUP BY event.preference_id
    )
    SELECT jsonb_build_object(
      'id', preference.id::text,
      'stableKey', preference.stable_key,
      'title', revision.title,
      'description', revision.description,
      'scope', scope.scope,
      'activeVersion', coalesce(activation.value, 0),
      'revisionId', revision.id::text,
      'contentHash', revision.content_hash,
      'precedence', jsonb_build_object(
        'tier', scope.scope,
        'rank', revision.precedence_rank,
        'conflictStrategy', revision.conflict_strategy,
        'conflictsWith', revision.conflicts_with
      ),
      'provenance', jsonb_build_object(
        'source', revision.provenance_source,
        'sourceIdHash', CASE
          WHEN revision.provenance_source_id IS NULL THEN NULL
          ELSE encode(
            sha256(convert_to(revision.provenance_source_id, 'UTF8')),
            'hex'
          )
        END,
        'trust', revision.trust
      ),
      'expiresAt', CASE
        WHEN revision.expires_at IS NULL THEN NULL
        ELSE to_char(
          revision.expires_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END,
      'retrievalHandle',
        'preference://' || preference.id::text || '/revisions/' || revision.id::text ||
        '?sha256=' || revision.content_hash
    )
    FROM state_event state
    JOIN scope_event scope ON scope.preference_id = state.preference_id
    JOIN preference_registry_preferences preference
      ON preference.account_id = p_account_id
      AND preference.id = state.preference_id
    JOIN preference_registry_revisions revision
      ON revision.account_id = preference.account_id
      AND revision.preference_id = preference.id
      AND revision.id = state.new_revision_id
    LEFT JOIN activation_version activation
      ON activation.preference_id = preference.id
    WHERE state.type IN ('activated', 'corrected')
      AND (revision.expires_at IS NULL OR revision.expires_at > p_accepted_at)
      AND (
        scope.scope = 'organization'
        OR (
          scope.scope = 'workspace'
          AND scope.scope_workspace_id = p_workspace_id
          AND scope.scope_subject_id IS NULL
        )
        OR (
          scope.scope = 'user'
          AND scope.scope_workspace_id IS NULL
          AND scope.scope_subject_id = p_initiating_human_subject_id
        )
      )
    ORDER BY CASE scope.scope
        WHEN 'organization' THEN 0
        WHEN 'workspace' THEN 1
        WHEN 'user' THEN 2
        ELSE 3
      END,
      revision.precedence_rank DESC,
      preference.stable_key,
      preference.id
  LOOP
    IF jsonb_array_length(canonical_descriptors) >= 64 THEN
      canonical_truncated := true;
      EXIT;
    END IF;
    candidate_descriptors := canonical_descriptors || jsonb_build_array(canonical_descriptor);
    IF octet_length(convert_to(candidate_descriptors::text, 'UTF8')) > 16384 THEN
      canonical_truncated := true;
      EXIT;
    END IF;
    canonical_descriptors := candidate_descriptors;
  END LOOP;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION preference_registry_canonical_snapshot_at(
  uuid,
  uuid,
  text,
  timestamptz
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION preference_registry_validate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authority_subject_id text;
  turn_accepted_at timestamptz;
  expected_descriptors jsonb;
  expected_truncated boolean;
BEGIN
  SELECT
    coalesce(
      turn.initiating_human_subject_id,
      CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
    ),
    turn.created_at
    INTO authority_subject_id, turn_accepted_at
  FROM session_turn_attempts attempt
  JOIN session_turns turn
    ON turn.account_id = attempt.account_id
    AND turn.workspace_id = attempt.workspace_id
    AND turn.session_id = attempt.session_id
    AND turn.id = attempt.turn_id
  JOIN sessions session
    ON session.account_id = attempt.account_id
    AND session.workspace_id = attempt.workspace_id
    AND session.id = attempt.session_id
  WHERE attempt.id = NEW.attempt_id
    AND attempt.account_id = NEW.account_id
    AND attempt.workspace_id = NEW.workspace_id
    AND attempt.session_id = NEW.session_id
    AND attempt.turn_id = NEW.turn_id
    AND attempt.execution_generation = NEW.execution_generation
    AND turn.execution_generation = NEW.execution_generation
    AND attempt.state IN ('claimed', 'running')
    AND turn.active_attempt_id = attempt.id
    AND session.active_turn_id = turn.id
    AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
    AND NOT EXISTS (
      SELECT 1
      FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = NEW.workspace_id
        AND interruption.attempt_id = NEW.attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    );
  IF authority_subject_id IS NULL
    OR length(btrim(authority_subject_id)) NOT BETWEEN 1 AND 1024
    OR NEW.initiating_human_subject_id IS DISTINCT FROM authority_subject_id
  THEN
    RAISE EXCEPTION 'preference snapshot requires exact immutable initiating-human authority'
      USING ERRCODE = '23514';
  END IF;

  SELECT result.canonical_descriptors, result.canonical_truncated
    INTO expected_descriptors, expected_truncated
  FROM preference_registry_canonical_snapshot_at(
    NEW.account_id,
    NEW.workspace_id,
    authority_subject_id,
    turn_accepted_at
  ) result;

  IF NEW.descriptors IS DISTINCT FROM expected_descriptors
    OR NEW.truncated IS DISTINCT FROM expected_truncated
    OR NEW.descriptor_hash IS DISTINCT FROM encode(
      sha256(convert_to(expected_descriptors::text, 'UTF8')),
      'hex'
    )
  THEN
    RAISE EXCEPTION 'preference snapshot is not the canonical accepted-turn descriptor set'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS preference_registry_snapshots_validate
  ON "preference_registry_snapshots";
CREATE TRIGGER preference_registry_snapshots_validate
  BEFORE INSERT ON "preference_registry_snapshots"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_validate_snapshot();

DO $preference_snapshot_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.preference_registry_get_or_create_snapshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS SETOF %I.preference_registry_snapshots
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      authority_subject_id text;
      turn_accepted_at timestamptz;
      canonical_descriptors jsonb;
      canonical_truncated boolean;
      canonical_hash text;
      snapshot_time timestamptz := transaction_timestamp();
      winner_id uuid;
    BEGIN
      context_account_id := NULLIF(
        current_setting('opengeni.account_id', true), ''
      )::uuid;
      context_workspace_id := NULLIF(
        current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR p_execution_generation < 1
      THEN
        RAISE EXCEPTION 'preference snapshot requires exact transaction-local tenant authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT
        coalesce(
          turn.initiating_human_subject_id,
          CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
        ),
        turn.created_at
        INTO authority_subject_id, turn_accepted_at
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id
        AND session.workspace_id = workspace.id
      JOIN session_turns turn
        ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id
        AND turn.session_id = session.id
      JOIN session_turn_attempts attempt
        ON attempt.account_id = turn.account_id
        AND attempt.workspace_id = turn.workspace_id
        AND attempt.session_id = turn.session_id
        AND attempt.turn_id = turn.id
      WHERE workspace.id = p_workspace_id
        AND workspace.account_id = p_account_id
        AND session.id = p_session_id
        AND session.active_turn_id = p_turn_id
        AND turn.id = p_turn_id
        AND turn.active_attempt_id = p_attempt_id
        AND turn.execution_generation = p_execution_generation
        AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
        AND attempt.id = p_attempt_id
        AND attempt.execution_generation = p_execution_generation
        AND attempt.state IN ('claimed', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn
      FOR UPDATE OF attempt;
      IF authority_subject_id IS NULL
        OR length(btrim(authority_subject_id)) NOT BETWEEN 1 AND 1024
      THEN
        RAISE EXCEPTION 'preference snapshot requires an immutable initiating human'
          USING ERRCODE = '42501';
      END IF;

      PERFORM set_config('opengeni.subject_id', authority_subject_id, true);
      IF NULLIF(current_setting('opengeni.subject_id', true), '')
        IS DISTINCT FROM authority_subject_id
      THEN
        RAISE EXCEPTION 'preference snapshot human authority was not applied'
          USING ERRCODE = '42501';
      END IF;

      SELECT snapshot.id INTO winner_id
      FROM preference_registry_snapshots snapshot
      WHERE snapshot.account_id = p_account_id
        AND snapshot.workspace_id = p_workspace_id
        AND snapshot.session_id = p_session_id
        AND snapshot.turn_id = p_turn_id
        AND snapshot.attempt_id = p_attempt_id
        AND snapshot.execution_generation = p_execution_generation
        AND snapshot.initiating_human_subject_id = authority_subject_id
      FOR SHARE;
      IF winner_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1
          FROM preference_registry_snapshots snapshot
          WHERE snapshot.id = winner_id
            AND (
              snapshot.created_at > transaction_timestamp()
              OR jsonb_typeof(snapshot.descriptors) <> 'array'
              OR jsonb_array_length(snapshot.descriptors) > 64
              OR octet_length(convert_to(snapshot.descriptors::text, 'UTF8')) > 16384
              OR snapshot.descriptor_hash IS DISTINCT FROM encode(
                sha256(convert_to(snapshot.descriptors::text, 'UTF8')),
                'hex'
              )
            )
        ) THEN
          RAISE EXCEPTION 'existing preference snapshot failed canonical integrity checks'
            USING ERRCODE = '23514';
        END IF;
        RETURN QUERY
        SELECT snapshot.*
        FROM preference_registry_snapshots snapshot
        WHERE snapshot.id = winner_id;
        RETURN;
      END IF;

      SELECT result.canonical_descriptors, result.canonical_truncated
        INTO canonical_descriptors, canonical_truncated
      FROM preference_registry_canonical_snapshot_at(
        p_account_id,
        p_workspace_id,
        authority_subject_id,
        turn_accepted_at
      ) result;
      canonical_hash := encode(
        sha256(convert_to(canonical_descriptors::text, 'UTF8')),
        'hex'
      );

      INSERT INTO preference_registry_snapshots (
        account_id,
        workspace_id,
        session_id,
        turn_id,
        attempt_id,
        execution_generation,
        initiating_human_subject_id,
        descriptors,
        descriptor_hash,
        truncated,
        created_at
      ) VALUES (
        p_account_id,
        p_workspace_id,
        p_session_id,
        p_turn_id,
        p_attempt_id,
        p_execution_generation,
        authority_subject_id,
        canonical_descriptors,
        canonical_hash,
        canonical_truncated,
        snapshot_time
      )
      ON CONFLICT (account_id, workspace_id, attempt_id) DO NOTHING
      RETURNING id INTO winner_id;
      IF winner_id IS NULL THEN
        SELECT snapshot.id INTO winner_id
        FROM preference_registry_snapshots snapshot
        WHERE snapshot.account_id = p_account_id
          AND snapshot.workspace_id = p_workspace_id
          AND snapshot.session_id = p_session_id
          AND snapshot.turn_id = p_turn_id
          AND snapshot.attempt_id = p_attempt_id
          AND snapshot.execution_generation = p_execution_generation
          AND snapshot.initiating_human_subject_id = authority_subject_id
        FOR SHARE;
      END IF;
      IF winner_id IS NULL THEN
        RAISE EXCEPTION 'preference snapshot winner conflicts with exact attempt authority'
          USING ERRCODE = '40001';
      END IF;
      IF EXISTS (
        SELECT 1
        FROM preference_registry_snapshots snapshot
        WHERE snapshot.id = winner_id
          AND (
            snapshot.descriptors IS DISTINCT FROM canonical_descriptors
            OR snapshot.descriptor_hash IS DISTINCT FROM canonical_hash
            OR snapshot.truncated IS DISTINCT FROM canonical_truncated
            OR snapshot.created_at IS DISTINCT FROM snapshot_time
          )
      ) THEN
        RAISE EXCEPTION 'preference snapshot winner is not the canonical accepted-turn snapshot'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY
      SELECT snapshot.*
      FROM preference_registry_snapshots snapshot
      WHERE snapshot.id = winner_id;
    END
    $body$
  $ddl$, target_schema, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.preference_registry_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.preference_registry_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END $preference_snapshot_function$;