-- deployment-mode: rolling
-- Canonical organization-wide company profile authority and exact-attempt
-- delivery. It does not use Documents/RAG, Memory, Preference Registry,
-- and workspace instruction-policy storage.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE SEQUENCE "company_profile_revision_seq" AS bigint;

CREATE TABLE "company_profile_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "revision" bigint NOT NULL DEFAULT nextval('company_profile_revision_seq'),
  "intent" text NOT NULL,
  "content_json" text NOT NULL,
  "content_hash" text NOT NULL,
  "provenance_source" text NOT NULL,
  "provenance_source_id" text,
  "supersedes_revision_id" uuid REFERENCES "company_profile_revisions"("id") ON DELETE RESTRICT,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_profile_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "company_profile_revisions_intent_chk" CHECK ("intent" IN ('active', 'proposal')),
  CONSTRAINT "company_profile_revisions_receipt_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "company_profile_revisions_content_chk" CHECK (
    octet_length(convert_to("content_json", 'UTF8')) BETWEEN 1 AND 28672
    AND "content_hash" ~ '^[0-9a-f]{64}$'
    AND "content_hash" = encode(sha256(convert_to("content_json", 'UTF8')), 'hex')
  ),
  CONSTRAINT "company_profile_revisions_provenance_chk" CHECK (
    "provenance_source" IN ('human', 'durable_learning', 'migration')
    AND (
      "provenance_source_id" IS NULL
      OR length("provenance_source_id") BETWEEN 1 AND 512
    )
  ),
  CONSTRAINT "company_profile_revisions_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "company_profile_revisions_account_operation_uq"
    UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "company_profile_revisions_account_revision_uq"
    UNIQUE ("account_id", "revision")
);

CREATE INDEX "company_profile_revisions_account_history_idx"
  ON "company_profile_revisions" ("account_id", "revision" DESC);

CREATE TABLE "company_profile_heads" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "revision_id" uuid NOT NULL REFERENCES "company_profile_revisions"("id") ON DELETE RESTRICT,
  "revision" bigint NOT NULL,
  "content_hash" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_profile_heads_identity_chk" CHECK (
    "revision" > 0
    AND "activation_version" > 0
    AND "content_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE "company_profile_activation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "request_fingerprint" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "activation_version" bigint NOT NULL,
  "old_revision_id" uuid REFERENCES "company_profile_revisions"("id") ON DELETE RESTRICT,
  "old_revision" bigint,
  "old_content_hash" text,
  "new_revision_id" uuid REFERENCES "company_profile_revisions"("id") ON DELETE RESTRICT,
  "new_revision" bigint,
  "new_content_hash" text,
  "actor_subject_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_profile_events_type_chk" CHECK ("type" IN ('activate', 'rollback')),
  CONSTRAINT "company_profile_events_receipt_chk" CHECK (
    "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "company_profile_events_old_revision_chk" CHECK (
    ("old_revision_id" IS NULL AND "old_revision" IS NULL AND "old_content_hash" IS NULL)
    OR (
      "old_revision_id" IS NOT NULL
      AND "old_revision" > 0
      AND "old_content_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "company_profile_events_new_revision_chk" CHECK (
    ("new_revision_id" IS NULL AND "new_revision" IS NULL AND "new_content_hash" IS NULL)
    OR (
      "new_revision_id" IS NOT NULL
      AND "new_revision" > 0
      AND "new_content_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "company_profile_events_audit_chk" CHECK (
    "activation_version" > 0
    AND length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("reason")) BETWEEN 1 AND 4096
  ),
  CONSTRAINT "company_profile_events_account_operation_uq"
    UNIQUE ("account_id", "operation_id"),
  CONSTRAINT "company_profile_events_account_version_uq"
    UNIQUE ("account_id", "activation_version")
);

CREATE INDEX "company_profile_events_account_time_idx"
  ON "company_profile_activation_events" ("account_id", "created_at" DESC, "id");

CREATE TABLE "company_profile_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE,
  "execution_generation" integer NOT NULL,
  "profile" jsonb,
  "snapshot_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "company_profile_snapshots_generation_chk" CHECK ("execution_generation" > 0),
  CONSTRAINT "company_profile_snapshots_profile_chk" CHECK (
    "profile" IS NULL OR jsonb_typeof("profile") = 'object'
  ),
  CONSTRAINT "company_profile_snapshots_hash_chk" CHECK (
    "snapshot_hash" ~ '^[0-9a-f]{64}$'
    AND "snapshot_hash" = encode(
      sha256(convert_to(coalesce("profile", 'null'::jsonb)::text, 'UTF8')),
      'hex'
    )
  ),
  CONSTRAINT "company_profile_snapshots_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "attempt_id")
);

CREATE INDEX "company_profile_snapshots_workspace_time_idx"
  ON "company_profile_snapshots" ("workspace_id", "created_at" DESC, "id");

CREATE OR REPLACE FUNCTION company_profile_validate_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile jsonb;
  field_name text;
  entries jsonb;
BEGIN
  BEGIN
    profile := NEW.content_json::jsonb;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'company profile content must be canonical JSON'
      USING ERRCODE = '23514';
  END;
  IF jsonb_typeof(profile) <> 'object'
    OR NOT profile ?& ARRAY['identity', 'mission', 'products', 'customers', 'goals', 'constraints']
    OR (profile - ARRAY['identity', 'mission', 'products', 'customers', 'goals', 'constraints']) <> '{}'::jsonb
  THEN
    RAISE EXCEPTION 'company profile must contain exactly the canonical fields'
      USING ERRCODE = '23514';
  END IF;
  IF (jsonb_typeof(profile->'identity') NOT IN ('string', 'null'))
    OR (jsonb_typeof(profile->'mission') NOT IN ('string', 'null'))
    OR (
      jsonb_typeof(profile->'identity') = 'string'
      AND length(btrim(profile->>'identity')) NOT BETWEEN 1 AND 2048
    )
    OR (
      jsonb_typeof(profile->'mission') = 'string'
      AND length(btrim(profile->>'mission')) NOT BETWEEN 1 AND 2048
    )
  THEN
    RAISE EXCEPTION 'company profile identity and mission are invalid'
      USING ERRCODE = '23514';
  END IF;
  FOREACH field_name IN ARRAY ARRAY['products', 'customers', 'goals', 'constraints'] LOOP
    entries := profile->field_name;
    IF jsonb_typeof(entries) <> 'array' OR jsonb_array_length(entries) > 16 THEN
      RAISE EXCEPTION 'company profile list field % is invalid', field_name
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(entries) item
      WHERE jsonb_typeof(item) <> 'object'
        OR NOT item ?& ARRAY['key', 'content']
        OR (item - ARRAY['key', 'content']) <> '{}'::jsonb
        OR jsonb_typeof(item->'key') <> 'string'
        OR jsonb_typeof(item->'content') <> 'string'
        OR length(item->>'key') NOT BETWEEN 1 AND 96
        OR item->>'key' <> lower(btrim(item->>'key'))
        OR item->>'key' !~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
        OR item->>'key' ~ '--'
        OR length(btrim(item->>'content')) NOT BETWEEN 1 AND 1024
    ) OR (
      SELECT count(*) FROM jsonb_array_elements(entries)
    ) <> (
      SELECT count(DISTINCT item->>'key') FROM jsonb_array_elements(entries) item
    ) THEN
      RAISE EXCEPTION 'company profile list field % contains invalid entries', field_name
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF profile->'identity' = 'null'::jsonb
    AND profile->'mission' = 'null'::jsonb
    AND jsonb_array_length(profile->'products') = 0
    AND jsonb_array_length(profile->'customers') = 0
    AND jsonb_array_length(profile->'goals') = 0
    AND jsonb_array_length(profile->'constraints') = 0
  THEN
    RAISE EXCEPTION 'company profile must contain at least one field'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.supersedes_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company_profile_revisions prior
    WHERE prior.id = NEW.supersedes_revision_id
      AND prior.account_id = NEW.account_id
  ) THEN
    RAISE EXCEPTION 'superseded company-profile revision must belong to the same account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_profile_revisions_validate
  BEFORE INSERT OR UPDATE ON "company_profile_revisions"
  FOR EACH ROW EXECUTE FUNCTION company_profile_validate_revision();

CREATE OR REPLACE FUNCTION company_profile_validate_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM company_profile_revisions revision
    WHERE revision.id = NEW.revision_id
      AND revision.account_id = NEW.account_id
      AND revision.revision = NEW.revision
      AND revision.content_hash = NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'company-profile head must identify an exact account revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_profile_heads_validate
  BEFORE INSERT OR UPDATE ON "company_profile_heads"
  FOR EACH ROW EXECUTE FUNCTION company_profile_validate_head();

CREATE OR REPLACE FUNCTION company_profile_validate_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.old_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company_profile_revisions revision
    WHERE revision.id = NEW.old_revision_id
      AND revision.account_id = NEW.account_id
      AND revision.revision = NEW.old_revision
      AND revision.content_hash = NEW.old_content_hash
  ) THEN
    RAISE EXCEPTION 'company-profile event has an invalid old revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.new_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM company_profile_revisions revision
    WHERE revision.id = NEW.new_revision_id
      AND revision.account_id = NEW.account_id
      AND revision.revision = NEW.new_revision
      AND revision.content_hash = NEW.new_content_hash
  ) THEN
    RAISE EXCEPTION 'company-profile event has an invalid new revision'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.old_revision_id IS NULL AND NEW.new_revision_id IS NULL THEN
    RAISE EXCEPTION 'company-profile event must change an active revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_profile_events_validate
  BEFORE INSERT OR UPDATE ON "company_profile_activation_events"
  FOR EACH ROW EXECUTE FUNCTION company_profile_validate_event();

CREATE OR REPLACE FUNCTION company_profile_reject_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND NOT EXISTS (SELECT 1 FROM managed_accounts account WHERE account.id = OLD.account_id)
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'company-profile history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER company_profile_revisions_immutable
  BEFORE UPDATE OR DELETE ON "company_profile_revisions"
  FOR EACH ROW EXECUTE FUNCTION company_profile_reject_history_mutation();
CREATE TRIGGER company_profile_events_immutable
  BEFORE UPDATE OR DELETE ON "company_profile_activation_events"
  FOR EACH ROW EXECUTE FUNCTION company_profile_reject_history_mutation();

CREATE OR REPLACE FUNCTION company_profile_canonical_snapshot_at(
  p_account_id uuid,
  p_accepted_at timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN event.new_revision_id IS NULL THEN NULL
    ELSE jsonb_build_object(
      'id', revision.id::text,
      'revision', revision.revision,
      'contentHash', revision.content_hash,
      'activationVersion', event.activation_version,
      'activatedAt', to_char(event.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'provenance', jsonb_build_object(
        'source', revision.provenance_source,
        'sourceIdHash', CASE
          WHEN revision.provenance_source_id IS NULL THEN NULL
          ELSE encode(sha256(convert_to(revision.provenance_source_id, 'UTF8')), 'hex')
        END
      )
    )
  END
  FROM (
    SELECT activation.*
    FROM company_profile_activation_events activation
    WHERE activation.account_id = p_account_id
      AND activation.created_at <= p_accepted_at
    ORDER BY activation.created_at DESC, activation.activation_version DESC, activation.id DESC
    LIMIT 1
  ) event
  LEFT JOIN company_profile_revisions revision
    ON revision.account_id = event.account_id
    AND revision.id = event.new_revision_id
    AND revision.revision = event.new_revision
    AND revision.content_hash = event.new_content_hash;
$$;

REVOKE ALL ON FUNCTION company_profile_canonical_snapshot_at(uuid, timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION company_profile_validate_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  accepted_at timestamptz;
  canonical_profile jsonb;
BEGIN
  SELECT turn.created_at INTO accepted_at
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
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = NEW.workspace_id
        AND interruption.attempt_id = NEW.attempt_id
        AND interruption.state IN ('pending', 'delivered', 'acknowledged')
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION 'company-profile snapshot requires an exact active attempt'
      USING ERRCODE = '23514';
  END IF;
  canonical_profile := company_profile_canonical_snapshot_at(NEW.account_id, accepted_at);
  IF NEW.profile IS DISTINCT FROM canonical_profile
    OR NEW.snapshot_hash IS DISTINCT FROM encode(
      sha256(convert_to(coalesce(canonical_profile, 'null'::jsonb)::text, 'UTF8')),
      'hex'
    )
  THEN
    RAISE EXCEPTION 'company-profile snapshot is not canonical for the accepted turn'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_profile_snapshots_validate
  BEFORE INSERT ON "company_profile_snapshots"
  FOR EACH ROW EXECUTE FUNCTION company_profile_validate_snapshot();

CREATE OR REPLACE FUNCTION company_profile_reject_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM managed_accounts WHERE id = OLD.account_id)
      OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
      OR NOT EXISTS (SELECT 1 FROM session_turns WHERE id = OLD.turn_id)
      OR NOT EXISTS (SELECT 1 FROM session_turn_attempts WHERE id = OLD.attempt_id)
    )
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'company-profile accepted-turn snapshots are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER company_profile_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "company_profile_snapshots"
  FOR EACH ROW EXECUTE FUNCTION company_profile_reject_snapshot_mutation();

ALTER TABLE "company_profile_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_heads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_activation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_activation_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_profile_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY account_isolation ON "company_profile_revisions"
  USING (opengeni_private.account_rls_visible("account_id"))
  WITH CHECK (opengeni_private.account_rls_visible("account_id"));
CREATE POLICY account_isolation ON "company_profile_heads"
  USING (opengeni_private.account_rls_visible("account_id"))
  WITH CHECK (opengeni_private.account_rls_visible("account_id"));
CREATE POLICY account_isolation ON "company_profile_activation_events"
  USING (opengeni_private.account_rls_visible("account_id"))
  WITH CHECK (opengeni_private.account_rls_visible("account_id"));
CREATE POLICY workspace_isolation ON "company_profile_snapshots"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

DO $snapshot_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.company_profile_get_or_create_snapshot(
      p_account_id uuid,
      p_workspace_id uuid,
      p_session_id uuid,
      p_turn_id uuid,
      p_attempt_id uuid,
      p_execution_generation integer
    ) RETURNS SETOF %I.company_profile_snapshots
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      accepted_at timestamptz;
      canonical_profile jsonb;
      canonical_hash text;
      snapshot_time timestamptz := transaction_timestamp();
      winner_id uuid;
    BEGIN
      context_account_id := NULLIF(current_setting('opengeni.account_id', true), '')::uuid;
      context_workspace_id := NULLIF(current_setting('opengeni.workspace_id', true), '')::uuid;
      IF context_account_id IS DISTINCT FROM p_account_id
        OR context_workspace_id IS DISTINCT FROM p_workspace_id
        OR p_execution_generation < 1
      THEN
        RAISE EXCEPTION 'company-profile snapshot requires exact tenant authority'
          USING ERRCODE = '42501';
      END IF;

      SELECT turn.created_at INTO accepted_at
      FROM workspaces workspace
      JOIN sessions session
        ON session.account_id = workspace.account_id AND session.workspace_id = workspace.id
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
          SELECT 1 FROM session_attempt_interruptions interruption
          WHERE interruption.workspace_id = attempt.workspace_id
            AND interruption.attempt_id = attempt.id
            AND interruption.state IN ('pending', 'delivered', 'acknowledged')
        )
      FOR KEY SHARE OF workspace
      FOR SHARE OF session, turn
      FOR UPDATE OF attempt;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'company-profile snapshot requires the exact current attempt'
          USING ERRCODE = '42501';
      END IF;

      SELECT snapshot.id INTO winner_id
      FROM company_profile_snapshots snapshot
      WHERE snapshot.account_id = p_account_id
        AND snapshot.workspace_id = p_workspace_id
        AND snapshot.session_id = p_session_id
        AND snapshot.turn_id = p_turn_id
        AND snapshot.attempt_id = p_attempt_id
        AND snapshot.execution_generation = p_execution_generation
      FOR SHARE;
      IF winner_id IS NOT NULL THEN
        RETURN QUERY SELECT snapshot.* FROM company_profile_snapshots snapshot WHERE snapshot.id = winner_id;
        RETURN;
      END IF;

      canonical_profile := company_profile_canonical_snapshot_at(p_account_id, accepted_at);
      canonical_hash := encode(
        sha256(convert_to(coalesce(canonical_profile, 'null'::jsonb)::text, 'UTF8')),
        'hex'
      );
      INSERT INTO company_profile_snapshots (
        account_id, workspace_id, session_id, turn_id, attempt_id,
        execution_generation, profile, snapshot_hash, created_at
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, canonical_profile, canonical_hash, snapshot_time
      )
      ON CONFLICT (account_id, workspace_id, attempt_id) DO NOTHING
      RETURNING id INTO winner_id;
      IF winner_id IS NULL THEN
        SELECT snapshot.id INTO winner_id
        FROM company_profile_snapshots snapshot
        WHERE snapshot.account_id = p_account_id
          AND snapshot.workspace_id = p_workspace_id
          AND snapshot.session_id = p_session_id
          AND snapshot.turn_id = p_turn_id
          AND snapshot.attempt_id = p_attempt_id
          AND snapshot.execution_generation = p_execution_generation
        FOR SHARE;
      END IF;
      IF winner_id IS NULL THEN
        RAISE EXCEPTION 'company-profile snapshot winner conflicts with exact attempt authority'
          USING ERRCODE = '40001';
      END IF;
      IF EXISTS (
        SELECT 1 FROM company_profile_snapshots snapshot
        WHERE snapshot.id = winner_id
          AND (
            snapshot.profile IS DISTINCT FROM canonical_profile
            OR snapshot.snapshot_hash IS DISTINCT FROM canonical_hash
            OR snapshot.created_at IS DISTINCT FROM snapshot_time
          )
      ) THEN
        RAISE EXCEPTION 'company-profile snapshot winner is not canonical'
          USING ERRCODE = '40001';
      END IF;
      RETURN QUERY SELECT snapshot.* FROM company_profile_snapshots snapshot WHERE snapshot.id = winner_id;
    END
    $body$
  $ddl$, target_schema, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.company_profile_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.company_profile_get_or_create_snapshot(uuid, uuid, uuid, uuid, uuid, integer) TO opengeni_app',
      target_schema
    );
  END IF;
END $snapshot_function$;

REVOKE ALL ON TABLE company_profile_revisions FROM PUBLIC;
REVOKE ALL ON TABLE company_profile_heads FROM PUBLIC;
REVOKE ALL ON TABLE company_profile_activation_events FROM PUBLIC;
REVOKE ALL ON TABLE company_profile_snapshots FROM PUBLIC;
REVOKE ALL ON SEQUENCE company_profile_revision_seq FROM PUBLIC;

DO $runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT ON TABLE company_profile_revisions TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE company_profile_heads TO opengeni_app;
    GRANT SELECT, INSERT ON TABLE company_profile_activation_events TO opengeni_app;
    GRANT SELECT ON TABLE company_profile_snapshots TO opengeni_app;
    GRANT USAGE, SELECT ON SEQUENCE company_profile_revision_seq TO opengeni_app;
  END IF;
END $runtime_grants$;