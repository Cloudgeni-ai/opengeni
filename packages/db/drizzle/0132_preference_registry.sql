-- deployment-mode: rolling
-- OPE-122: additive, backend-only structured preference registry. No prompt
-- composition, document ingestion, knowledge-memory mutation, or backfill.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE SEQUENCE IF NOT EXISTS "preference_registry_revision_seq" AS bigint;

CREATE TABLE "preference_registry_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "stable_key" text NOT NULL,
  "scope" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "scope_subject_id" text,
  "status" text NOT NULL DEFAULT 'proposed',
  "scope_version" integer NOT NULL DEFAULT 1,
  "activation_version" integer NOT NULL DEFAULT 0,
  "active_revision_id" uuid,
  "active_revision" bigint,
  "active_content_hash" text,
  "superseded_by_preference_id" uuid,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "preference_registry_preferences_key_chk" CHECK (
    length("stable_key") BETWEEN 1 AND 96
    AND "stable_key" = lower(btrim("stable_key"))
    AND "stable_key" ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'
    AND "stable_key" !~ '--'
  ),
  CONSTRAINT "preference_registry_preferences_scope_shape_chk" CHECK (
    ("scope" = 'organization' AND "scope_workspace_id" IS NULL AND "scope_subject_id" IS NULL)
    OR ("scope" = 'workspace' AND "scope_workspace_id" IS NOT NULL AND "scope_subject_id" IS NULL)
    OR ("scope" = 'user' AND "scope_workspace_id" IS NULL AND "scope_subject_id" IS NOT NULL)
  ),
  CONSTRAINT "preference_registry_preferences_status_chk" CHECK (
    "status" IN ('proposed', 'active', 'inactive', 'rejected', 'superseded')
  ),
  CONSTRAINT "preference_registry_preferences_versions_chk" CHECK (
    "scope_version" > 0 AND "activation_version" >= 0
  ),
  CONSTRAINT "preference_registry_preferences_head_shape_chk" CHECK (
    ("active_revision_id" IS NULL AND "active_revision" IS NULL AND "active_content_hash" IS NULL)
    OR ("active_revision_id" IS NOT NULL AND "active_revision" > 0
        AND "active_content_hash" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "preference_registry_preferences_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "preference_registry_preferences_account_id_uq" UNIQUE ("account_id", "id")
);

-- Stable keys identify one preference within a target, not across a tenant.
-- The same key may therefore layer at organization, workspace, and user tiers.
CREATE UNIQUE INDEX "preference_registry_preferences_organization_key_uq"
  ON "preference_registry_preferences" ("account_id", "stable_key")
  WHERE "scope" = 'organization';
CREATE UNIQUE INDEX "preference_registry_preferences_workspace_key_uq"
  ON "preference_registry_preferences" ("account_id", "scope_workspace_id", "stable_key")
  WHERE "scope" = 'workspace';
CREATE UNIQUE INDEX "preference_registry_preferences_user_key_uq"
  ON "preference_registry_preferences" ("account_id", "scope_subject_id", "stable_key")
  WHERE "scope" = 'user';

ALTER TABLE "preference_registry_preferences"
  ADD CONSTRAINT "preference_registry_preferences_superseded_by_fk"
  FOREIGN KEY ("account_id", "superseded_by_preference_id")
  REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE RESTRICT;

CREATE INDEX "preference_registry_preferences_applicable_idx"
  ON "preference_registry_preferences"
  ("account_id", "scope", "scope_workspace_id", "scope_subject_id", "status", "stable_key");

CREATE TABLE "preference_registry_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "preference_id" uuid NOT NULL,
  "revision" bigint NOT NULL DEFAULT nextval('preference_registry_revision_seq'),
  "title" text NOT NULL,
  "description" text NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "precedence_rank" integer NOT NULL DEFAULT 0,
  "conflict_strategy" text NOT NULL,
  "conflicts_with" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provenance_source" text NOT NULL,
  "provenance_source_id" text,
  "trust" text NOT NULL,
  "expires_at" timestamptz,
  "corrects_revision_id" uuid REFERENCES "preference_registry_revisions"("id") ON DELETE RESTRICT,
  "created_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "preference_registry_revisions_preference_fk"
    FOREIGN KEY ("account_id", "preference_id")
    REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE CASCADE,
  CONSTRAINT "preference_registry_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "preference_registry_revisions_text_chk" CHECK (
    length(btrim("title")) BETWEEN 1 AND 120
    AND length(btrim("description")) BETWEEN 1 AND 240
    AND length(btrim("content")) > 0
    AND length("content") <= 262144
  ),
  CONSTRAINT "preference_registry_revisions_hash_chk" CHECK (
    "content_hash" ~ '^[0-9a-f]{64}$'
    AND "content_hash" = encode(sha256(convert_to("content", 'UTF8')), 'hex')
  ),
  CONSTRAINT "preference_registry_revisions_precedence_chk" CHECK (
    "precedence_rank" BETWEEN -1000 AND 1000
    AND "conflict_strategy" IN ('override', 'merge', 'reject', 'inform')
    AND jsonb_typeof("conflicts_with") = 'array'
    AND jsonb_array_length("conflicts_with") <= 32
  ),
  CONSTRAINT "preference_registry_revisions_provenance_chk" CHECK (
    "provenance_source" IN (
      'human', 'onboarding', 'knowledge_proposal', 'imported_document',
      'slack', 'meeting_transcript', 'call_transcript'
    )
    AND "trust" IN ('untrusted_proposal', 'personal', 'workspace_managed', 'organization_managed')
    AND ("provenance_source_id" IS NULL OR length("provenance_source_id") BETWEEN 1 AND 512)
    AND (
      "provenance_source" IN ('human', 'onboarding')
      OR "provenance_source_id" IS NOT NULL
    )
  ),
  CONSTRAINT "preference_registry_revisions_actor_chk" CHECK (
    length(btrim("created_by_subject_id")) BETWEEN 1 AND 1024
  ),
  CONSTRAINT "preference_registry_revisions_preference_revision_uq"
    UNIQUE ("preference_id", "revision"),
  CONSTRAINT "preference_registry_revisions_preference_id_uq"
    UNIQUE ("preference_id", "id")
);

CREATE INDEX "preference_registry_revisions_history_idx"
  ON "preference_registry_revisions" ("preference_id", "revision" DESC);

ALTER TABLE "preference_registry_preferences"
  ADD CONSTRAINT "preference_registry_preferences_active_revision_fk"
  FOREIGN KEY ("id", "active_revision_id")
  REFERENCES "preference_registry_revisions"("preference_id", "id") ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE "preference_registry_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "preference_id" uuid NOT NULL,
  "type" text NOT NULL,
  "version" integer NOT NULL,
  "old_revision_id" uuid,
  "new_revision_id" uuid,
  "old_scope" text,
  "old_workspace_id" uuid,
  "old_subject_id" text,
  "new_scope" text,
  "new_workspace_id" uuid,
  "new_subject_id" text,
  "related_preference_id" uuid,
  "actor_subject_id" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "preference_registry_events_preference_fk"
    FOREIGN KEY ("account_id", "preference_id")
    REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE CASCADE,
  CONSTRAINT "preference_registry_events_old_revision_fk"
    FOREIGN KEY ("preference_id", "old_revision_id")
    REFERENCES "preference_registry_revisions"("preference_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "preference_registry_events_new_revision_fk"
    FOREIGN KEY ("preference_id", "new_revision_id")
    REFERENCES "preference_registry_revisions"("preference_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "preference_registry_events_related_fk"
    FOREIGN KEY ("account_id", "related_preference_id")
    REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "preference_registry_events_type_chk" CHECK (
    "type" IN (
      'proposal_created', 'activated', 'corrected', 'rejected',
      'deactivated', 'superseded', 'scope_changed'
    )
  ),
  CONSTRAINT "preference_registry_events_version_chk" CHECK ("version" > 0),
  CONSTRAINT "preference_registry_events_audit_chk" CHECK (
    length(btrim("actor_subject_id")) BETWEEN 1 AND 1024
    AND length(btrim("reason")) BETWEEN 1 AND 4096
  ),
  CONSTRAINT "preference_registry_events_preference_version_uq" UNIQUE ("preference_id", "version")
);

CREATE INDEX "preference_registry_events_timeline_idx"
  ON "preference_registry_events" ("preference_id", "created_at" DESC, "id");

CREATE TABLE "preference_registry_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE CASCADE,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE CASCADE,
  "execution_generation" integer NOT NULL,
  "initiating_human_subject_id" text NOT NULL,
  "descriptors" jsonb NOT NULL,
  "descriptor_hash" text NOT NULL,
  "truncated" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "preference_registry_snapshots_human_chk" CHECK (
    length(btrim("initiating_human_subject_id")) BETWEEN 1 AND 1024
    AND "execution_generation" > 0
  ),
  CONSTRAINT "preference_registry_snapshots_descriptors_chk" CHECK (
    jsonb_typeof("descriptors") = 'array' AND jsonb_array_length("descriptors") <= 64
  ),
  CONSTRAINT "preference_registry_snapshots_descriptor_bytes_chk" CHECK (
    octet_length(convert_to("descriptors"::text, 'UTF8')) <= 16384
  ),
  CONSTRAINT "preference_registry_snapshots_hash_chk" CHECK (
    "descriptor_hash" ~ '^[0-9a-f]{64}$'
    AND "descriptor_hash" = encode(sha256(convert_to("descriptors"::text, 'UTF8')), 'hex')
  ),
  CONSTRAINT "preference_registry_snapshots_attempt_uq"
    UNIQUE ("account_id", "workspace_id", "attempt_id")
);

CREATE INDEX "preference_registry_snapshots_human_timeline_idx"
  ON "preference_registry_snapshots"
  ("workspace_id", "initiating_human_subject_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION preference_registry_validate_head()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.active_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM preference_registry_revisions revision
    WHERE revision.id = NEW.active_revision_id
      AND revision.preference_id = NEW.id
      AND revision.account_id = NEW.account_id
      AND revision.revision = NEW.active_revision
      AND revision.content_hash = NEW.active_content_hash
  ) THEN
    RAISE EXCEPTION 'preference registry head must identify an exact immutable revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preference_registry_preferences_validate_head
  BEFORE INSERT OR UPDATE ON "preference_registry_preferences"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_validate_head();

CREATE OR REPLACE FUNCTION preference_registry_validate_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
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
      AND turn.initiator_kind = 'subject'
      AND turn.initiator_subject_id = NEW.initiating_human_subject_id
      AND NOT EXISTS (
        SELECT 1 FROM session_attempt_interruptions interruption
        WHERE interruption.workspace_id = NEW.workspace_id
          AND interruption.attempt_id = NEW.attempt_id
          AND interruption.state IN ('pending', 'delivered', 'acknowledged')
      )
  ) THEN
    RAISE EXCEPTION 'preference snapshot requires an exact active human-initiated attempt'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(NEW.descriptors) <> 'array' THEN
    RAISE EXCEPTION 'preference snapshot descriptors must be an array'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT descriptor->>'id')
    FROM jsonb_array_elements(NEW.descriptors) descriptor
  ) THEN
    RAISE EXCEPTION 'preference snapshot descriptors must identify unique preferences'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.descriptors) descriptor
    WHERE jsonb_typeof(descriptor) <> 'object'
      OR NOT EXISTS (
        SELECT 1
        FROM preference_registry_preferences preference
        JOIN preference_registry_revisions revision
          ON revision.account_id = preference.account_id
          AND revision.preference_id = preference.id
          AND revision.id = preference.active_revision_id
        WHERE preference.account_id = NEW.account_id
          AND preference.id::text = descriptor->>'id'
          AND preference.stable_key = descriptor->>'stableKey'
          AND preference.scope = descriptor->>'scope'
          AND preference.status = 'active'
          AND preference.activation_version::text = descriptor->>'activeVersion'
          AND revision.id::text = descriptor->>'revisionId'
          AND revision.content_hash = descriptor->>'contentHash'
          AND (revision.expires_at IS NULL OR revision.expires_at > NEW.created_at)
          AND opengeni_private.preference_registry_scope_visible(
            preference.account_id,
            preference.scope,
            preference.scope_workspace_id,
            preference.scope_subject_id
          )
          AND descriptor->>'retrievalHandle' =
            'preference://' || preference.id::text || '/revisions/' || revision.id::text ||
            '?sha256=' || revision.content_hash
          AND descriptor = jsonb_build_object(
            'id', preference.id::text,
            'stableKey', preference.stable_key,
            'title', revision.title,
            'description', revision.description,
            'scope', preference.scope,
            'activeVersion', preference.activation_version,
            'revisionId', revision.id::text,
            'contentHash', revision.content_hash,
            'precedence', jsonb_build_object(
              'tier', preference.scope,
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
      )
  ) THEN
    RAISE EXCEPTION 'preference snapshot contains a non-visible or inexact descriptor'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER preference_registry_snapshots_validate
  BEFORE INSERT ON "preference_registry_snapshots"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_validate_snapshot();

CREATE OR REPLACE FUNCTION preference_registry_reject_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- OLD has a different row type for snapshots versus revision/event rows;
    -- branch before referencing table-specific fields so PL/pgSQL never plans
    -- an invalid record-field access. Parent absence plus nested depth is the
    -- same fail-closed cascade proof used by the OPE-106 history trigger.
    IF TG_TABLE_NAME = 'preference_registry_snapshots' THEN
      IF NOT EXISTS (
        SELECT 1 FROM workspaces workspace WHERE workspace.id = OLD.workspace_id
      ) THEN
        RETURN OLD;
      END IF;
    ELSE
      IF NOT EXISTS (
        SELECT 1 FROM preference_registry_preferences preference
        WHERE preference.id = OLD.preference_id
      ) THEN
        RETURN OLD;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'preference registry history is immutable' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER preference_registry_revisions_immutable
  BEFORE UPDATE OR DELETE ON "preference_registry_revisions"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_reject_history_mutation();
CREATE TRIGGER preference_registry_events_immutable
  BEFORE UPDATE OR DELETE ON "preference_registry_events"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_reject_history_mutation();
CREATE TRIGGER preference_registry_snapshots_immutable
  BEFORE UPDATE OR DELETE ON "preference_registry_snapshots"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_reject_history_mutation();

CREATE OR REPLACE FUNCTION opengeni_private.preference_registry_scope_visible(
  row_account_id uuid,
  row_scope text,
  row_workspace_id uuid,
  row_subject_id text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT row_account_id = opengeni_private.current_account_id()
    AND (
      row_scope = 'organization'
      OR (row_scope = 'workspace' AND row_workspace_id = opengeni_private.current_workspace_id())
      OR (row_scope = 'user' AND row_subject_id = opengeni_private.current_subject_id())
    );
$$;

ALTER TABLE "preference_registry_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_preferences" FORCE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "preference_registry_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY preference_registry_scope_isolation ON "preference_registry_preferences"
  USING (opengeni_private.preference_registry_scope_visible(
    account_id, scope, scope_workspace_id, scope_subject_id
  ))
  WITH CHECK (opengeni_private.preference_registry_scope_visible(
    account_id, scope, scope_workspace_id, scope_subject_id
  ));

CREATE POLICY preference_registry_scope_isolation ON "preference_registry_revisions"
  USING (EXISTS (
    SELECT 1 FROM preference_registry_preferences preference
    WHERE preference.id = preference_registry_revisions.preference_id
      AND preference.account_id = preference_registry_revisions.account_id
  ) OR EXISTS (
    SELECT 1 FROM preference_registry_snapshots snapshot
    WHERE snapshot.account_id = preference_registry_revisions.account_id
      AND snapshot.workspace_id = opengeni_private.current_workspace_id()
      AND snapshot.initiating_human_subject_id = opengeni_private.current_subject_id()
      AND snapshot.descriptors @> jsonb_build_array(
        jsonb_build_object(
          'id', preference_registry_revisions.preference_id::text,
          'revisionId', preference_registry_revisions.id::text,
          'contentHash', preference_registry_revisions.content_hash
        )
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM preference_registry_preferences preference
    WHERE preference.id = preference_registry_revisions.preference_id
      AND preference.account_id = preference_registry_revisions.account_id
  ));

CREATE POLICY preference_registry_scope_isolation ON "preference_registry_events"
  USING (EXISTS (
    SELECT 1 FROM preference_registry_preferences preference
    WHERE preference.id = preference_registry_events.preference_id
      AND preference.account_id = preference_registry_events.account_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM preference_registry_preferences preference
    WHERE preference.id = preference_registry_events.preference_id
      AND preference.account_id = preference_registry_events.account_id
  ));

CREATE POLICY preference_registry_snapshot_isolation ON "preference_registry_snapshots"
  USING (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND initiating_human_subject_id = opengeni_private.current_subject_id()
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND initiating_human_subject_id = opengeni_private.current_subject_id()
  );

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.preference_registry_preferences TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.preference_registry_revisions, %I.preference_registry_events, %I.preference_registry_snapshots TO opengeni_app',
      target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %I.preference_registry_revision_seq TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;