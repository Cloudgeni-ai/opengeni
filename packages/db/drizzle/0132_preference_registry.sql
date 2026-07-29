-- deployment-mode: rolling
-- OPE-122: additive, backend-only structured preference registry. No prompt
-- composition, document ingestion, knowledge-memory mutation, or backfill.

SET lock_timeout = '5s';
SET statement_timeout = '10min';

CREATE SEQUENCE IF NOT EXISTS "preference_registry_revision_seq" AS bigint;

CREATE TABLE "preference_registry_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "stable_key" text NOT NULL,
  "scope" text NOT NULL,
  "scope_workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE RESTRICT,
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
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
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
    REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE RESTRICT,
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
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
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
    REFERENCES "preference_registry_preferences"("account_id", "id") ON DELETE RESTRICT,
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
  CONSTRAINT "preference_registry_events_shape_chk" CHECK (
    (
      "type" = 'proposal_created'
      AND "old_revision_id" IS NULL AND "new_revision_id" IS NOT NULL
      AND "old_scope" IS NULL AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL
      AND "new_scope" IS NOT NULL AND "related_preference_id" IS NULL
      AND (
        ("new_scope" = 'organization' AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL)
        OR ("new_scope" = 'workspace' AND "new_workspace_id" IS NOT NULL AND "new_subject_id" IS NULL)
        OR ("new_scope" = 'user' AND "new_workspace_id" IS NULL AND "new_subject_id" IS NOT NULL)
      )
    ) OR (
      "type" IN ('activated', 'corrected')
      AND "new_revision_id" IS NOT NULL
      AND "old_scope" IS NULL AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL
      AND "new_scope" IS NULL AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL
      AND "related_preference_id" IS NULL
      AND ("type" <> 'corrected' OR "old_revision_id" IS NOT NULL)
    ) OR (
      "type" = 'rejected'
      AND "old_revision_id" IS NULL AND "new_revision_id" IS NOT NULL
      AND "old_scope" IS NULL AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL
      AND "new_scope" IS NULL AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL
      AND "related_preference_id" IS NULL
    ) OR (
      "type" = 'deactivated'
      AND "old_revision_id" IS NOT NULL AND "new_revision_id" IS NULL
      AND "old_scope" IS NULL AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL
      AND "new_scope" IS NULL AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL
      AND "related_preference_id" IS NULL
    ) OR (
      "type" = 'superseded'
      AND "old_revision_id" IS NOT NULL AND "new_revision_id" IS NULL
      AND "old_scope" IS NULL AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL
      AND "new_scope" IS NULL AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL
      AND "related_preference_id" IS NOT NULL
      AND "related_preference_id" <> "preference_id"
    ) OR (
      "type" = 'scope_changed'
      AND "old_revision_id" IS NULL AND "new_revision_id" IS NULL
      AND "old_scope" IS NOT NULL AND "new_scope" IS NOT NULL AND "old_scope" <> "new_scope"
      AND "related_preference_id" IS NULL
      AND (
        ("old_scope" = 'organization' AND "old_workspace_id" IS NULL AND "old_subject_id" IS NULL)
        OR ("old_scope" = 'workspace' AND "old_workspace_id" IS NOT NULL AND "old_subject_id" IS NULL)
        OR ("old_scope" = 'user' AND "old_workspace_id" IS NULL AND "old_subject_id" IS NOT NULL)
      )
      AND (
        ("new_scope" = 'organization' AND "new_workspace_id" IS NULL AND "new_subject_id" IS NULL)
        OR ("new_scope" = 'workspace' AND "new_workspace_id" IS NOT NULL AND "new_subject_id" IS NULL)
        OR ("new_scope" = 'user' AND "new_workspace_id" IS NULL AND "new_subject_id" IS NOT NULL)
      )
    )
  ),
  CONSTRAINT "preference_registry_events_preference_version_uq" UNIQUE ("preference_id", "version")
);

CREATE INDEX "preference_registry_events_timeline_idx"
  ON "preference_registry_events" ("preference_id", "created_at" DESC, "id");

CREATE TABLE "preference_registry_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE RESTRICT,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT,
  "session_id" uuid NOT NULL REFERENCES "sessions"("id") ON DELETE RESTRICT,
  "turn_id" uuid NOT NULL REFERENCES "session_turns"("id") ON DELETE RESTRICT,
  "attempt_id" uuid NOT NULL REFERENCES "session_turn_attempts"("id") ON DELETE RESTRICT,
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

CREATE OR REPLACE FUNCTION preference_registry_guard_head_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lifecycle_operation text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'preference registry heads cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF current_setting('opengeni.preference_lifecycle_head_id', true)
      IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'preference registry heads change only through the lifecycle function'
      USING ERRCODE = '55000';
  END IF;
  lifecycle_operation := current_setting('opengeni.preference_lifecycle_operation', true);
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.stable_key IS DISTINCT FROM OLD.stable_key
    OR NEW.created_by_subject_id IS DISTINCT FROM OLD.created_by_subject_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'preference registry stable identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF lifecycle_operation IN ('activate', 'correct') THEN
    IF NEW.status <> 'active'
      OR NEW.active_revision_id IS NULL
      OR NEW.activation_version <> OLD.activation_version + 1
      OR NEW.scope_version <> OLD.scope_version
      OR ROW(NEW.scope, NEW.scope_workspace_id, NEW.scope_subject_id)
        IS DISTINCT FROM ROW(OLD.scope, OLD.scope_workspace_id, OLD.scope_subject_id)
      OR NEW.superseded_by_preference_id IS DISTINCT FROM OLD.superseded_by_preference_id
    THEN
      RAISE EXCEPTION 'invalid preference activation transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF lifecycle_operation = 'reject' THEN
    IF OLD.status <> 'proposed' OR NEW.status <> 'rejected'
      OR NEW.scope_version <> OLD.scope_version
      OR NEW.activation_version <> OLD.activation_version
      OR ROW(NEW.scope, NEW.scope_workspace_id, NEW.scope_subject_id)
        IS DISTINCT FROM ROW(OLD.scope, OLD.scope_workspace_id, OLD.scope_subject_id)
      OR ROW(NEW.active_revision_id, NEW.active_revision, NEW.active_content_hash)
        IS DISTINCT FROM ROW(OLD.active_revision_id, OLD.active_revision, OLD.active_content_hash)
      OR NEW.superseded_by_preference_id IS DISTINCT FROM OLD.superseded_by_preference_id
    THEN
      RAISE EXCEPTION 'invalid preference rejection transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF lifecycle_operation = 'deactivate' THEN
    IF OLD.status <> 'active' OR NEW.status <> 'inactive'
      OR OLD.active_revision_id IS NULL OR NEW.active_revision_id IS NOT NULL
      OR NEW.active_revision IS NOT NULL OR NEW.active_content_hash IS NOT NULL
      OR NEW.activation_version <> OLD.activation_version + 1
      OR NEW.scope_version <> OLD.scope_version
      OR ROW(NEW.scope, NEW.scope_workspace_id, NEW.scope_subject_id)
        IS DISTINCT FROM ROW(OLD.scope, OLD.scope_workspace_id, OLD.scope_subject_id)
      OR NEW.superseded_by_preference_id IS DISTINCT FROM OLD.superseded_by_preference_id
    THEN
      RAISE EXCEPTION 'invalid preference deactivation transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF lifecycle_operation = 'scope' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.scope = OLD.scope
      OR NEW.scope_version <> OLD.scope_version + 1
      OR NEW.activation_version <> OLD.activation_version
      OR ROW(NEW.active_revision_id, NEW.active_revision, NEW.active_content_hash)
        IS DISTINCT FROM ROW(OLD.active_revision_id, OLD.active_revision, OLD.active_content_hash)
      OR NEW.superseded_by_preference_id IS DISTINCT FROM OLD.superseded_by_preference_id
    THEN
      RAISE EXCEPTION 'invalid preference scope transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF lifecycle_operation = 'supersede' THEN
    IF OLD.status <> 'active' OR NEW.status <> 'superseded'
      OR NEW.superseded_by_preference_id IS NULL
      OR NEW.superseded_by_preference_id = OLD.id
      OR NEW.scope_version <> OLD.scope_version
      OR NEW.activation_version <> OLD.activation_version
      OR ROW(NEW.scope, NEW.scope_workspace_id, NEW.scope_subject_id)
        IS DISTINCT FROM ROW(OLD.scope, OLD.scope_workspace_id, OLD.scope_subject_id)
      OR ROW(NEW.active_revision_id, NEW.active_revision, NEW.active_content_hash)
        IS DISTINCT FROM ROW(OLD.active_revision_id, OLD.active_revision, OLD.active_content_hash)
    THEN
      RAISE EXCEPTION 'invalid preference supersession transition'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'preference registry lifecycle operation is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER preference_registry_preferences_lifecycle_only
  BEFORE UPDATE OR DELETE ON "preference_registry_preferences"
  FOR EACH ROW EXECUTE FUNCTION preference_registry_guard_head_mutation();

CREATE OR REPLACE FUNCTION preference_registry_require_proposal_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM preference_registry_events event
    WHERE event.account_id = NEW.account_id
      AND event.preference_id = NEW.id
      AND event.type = 'proposal_created'
      AND event.version = 1
      AND event.old_revision_id IS NULL
      AND event.new_revision_id IS NOT NULL
      AND event.old_scope IS NULL
      AND event.new_scope = NEW.scope
      AND event.new_workspace_id IS NOT DISTINCT FROM NEW.scope_workspace_id
      AND event.new_subject_id IS NOT DISTINCT FROM NEW.scope_subject_id
  ) THEN
    RAISE EXCEPTION 'preference proposal requires an exact immutable creation event'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER preference_registry_preferences_require_proposal_event
  AFTER INSERT ON "preference_registry_preferences"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION preference_registry_require_proposal_event();

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

DO $snapshot_function$
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
      snapshot_time timestamptz := transaction_timestamp();
      winner_id uuid;
      canonical_descriptor jsonb;
      canonical_descriptors jsonb := '[]'::jsonb;
      candidate_descriptors jsonb;
      canonical_hash text;
      canonical_truncated boolean := false;
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

      SELECT turn.initiator_subject_id INTO authority_subject_id
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
        AND turn.initiator_kind = 'subject'
        AND length(btrim(turn.initiator_subject_id)) BETWEEN 1 AND 1024
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
      IF authority_subject_id IS NULL THEN
        RAISE EXCEPTION 'preference snapshot requires the exact current human attempt'
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
                sha256(convert_to(snapshot.descriptors::text, 'UTF8')), 'hex'
              )
              OR (
                SELECT count(*) <> count(DISTINCT descriptor->>'id')
                FROM jsonb_array_elements(snapshot.descriptors) descriptor
              )
            )
        ) THEN
          RAISE EXCEPTION 'existing preference snapshot winner failed canonical integrity checks'
            USING ERRCODE = '23514';
        END IF;
        RETURN QUERY
        SELECT snapshot.*
        FROM preference_registry_snapshots snapshot
        WHERE snapshot.id = winner_id;
        RETURN;
      END IF;

      FOR canonical_descriptor IN
        SELECT jsonb_build_object(
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
        FROM preference_registry_preferences preference
        JOIN preference_registry_revisions revision
          ON revision.account_id = preference.account_id
          AND revision.preference_id = preference.id
          AND revision.id = preference.active_revision_id
        WHERE preference.account_id = p_account_id
          AND preference.status = 'active'
          AND (revision.expires_at IS NULL OR revision.expires_at > snapshot_time)
          AND opengeni_private.preference_registry_scope_visible(
            preference.account_id,
            preference.scope,
            preference.scope_workspace_id,
            preference.scope_subject_id
          )
        ORDER BY CASE preference.scope
            WHEN 'organization' THEN 0
            WHEN 'workspace' THEN 1
            WHEN 'user' THEN 2
            ELSE 3
          END,
          revision.precedence_rank DESC,
          preference.stable_key,
          preference.id
        FOR SHARE OF preference
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
      canonical_hash := encode(
        sha256(convert_to(canonical_descriptors::text, 'UTF8')), 'hex'
      );

      INSERT INTO preference_registry_snapshots (
        account_id, workspace_id, session_id, turn_id, attempt_id,
        execution_generation, initiating_human_subject_id,
        descriptors, descriptor_hash, truncated, created_at
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_attempt_id,
        p_execution_generation, authority_subject_id,
        canonical_descriptors, canonical_hash, canonical_truncated, snapshot_time
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
        RAISE EXCEPTION 'preference snapshot winner is not the canonical locked snapshot'
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
END $snapshot_function$;

DO $lock_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.preference_registry_lock_heads(p_preference_ids uuid[])
    RETURNS TABLE (preference_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
      requested_count integer;
      locked_count integer;
    BEGIN
      context_account_id := NULLIF(
        current_setting('opengeni.account_id', true), ''
      )::uuid;
      context_workspace_id := NULLIF(
        current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      context_subject_id := NULLIF(
        current_setting('opengeni.subject_id', true), ''
      );
      SELECT count(DISTINCT requested_id) INTO requested_count
      FROM unnest(p_preference_ids) requested_id;
      IF context_account_id IS NULL OR context_workspace_id IS NULL
        OR context_subject_id IS NULL
        OR requested_count < 1 OR requested_count > 2
        OR requested_count <> cardinality(p_preference_ids)
      THEN
        RAISE EXCEPTION 'preference head lock requires exact transaction-local scope'
          USING ERRCODE = '42501';
      END IF;
      PERFORM 1
      FROM preference_registry_preferences candidate
      WHERE candidate.id = ANY(p_preference_ids)
        AND candidate.account_id = context_account_id
        AND opengeni_private.preference_registry_scope_visible(
          candidate.account_id,
          candidate.scope,
          candidate.scope_workspace_id,
          candidate.scope_subject_id
        )
      ORDER BY candidate.id
      FOR UPDATE;
      GET DIAGNOSTICS locked_count = ROW_COUNT;
      IF locked_count <> requested_count THEN
        RAISE EXCEPTION 'preference head was not found in the authorized scope'
          USING ERRCODE = '42501';
      END IF;
      RETURN QUERY
      SELECT candidate.id
      FROM preference_registry_preferences candidate
      WHERE candidate.id = ANY(p_preference_ids)
      ORDER BY candidate.id;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.preference_registry_lock_heads(uuid[]) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.preference_registry_lock_heads(uuid[]) TO opengeni_app',
      target_schema
    );
  END IF;
END $lock_function$;

DO $lifecycle_function$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %I.preference_registry_apply_lifecycle(
      p_operation text,
      p_preference_id uuid,
      p_expected_scope_version integer,
      p_expected_revision_id uuid,
      p_revision_id uuid,
      p_new_scope text,
      p_related_preference_id uuid,
      p_actor_subject_id text,
      p_reason text
    ) RETURNS TABLE (event_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = %I, pg_catalog
    AS $body$
    DECLARE
      preference record;
      replacement record;
      replacement_revision record;
      revision record;
      context_account_id uuid;
      context_workspace_id uuid;
      context_subject_id text;
      context_principal_kind text;
      next_event_version integer;
      event_type text;
      old_revision_id uuid;
      new_revision_id uuid;
      old_scope text;
      old_workspace_id uuid;
      old_subject_id text;
      new_scope text;
      new_workspace_id uuid;
      new_subject_id text;
      related_preference_id uuid;
      lifecycle_lock_count integer;
    BEGIN
      context_account_id := NULLIF(
        current_setting('opengeni.account_id', true), ''
      )::uuid;
      context_workspace_id := NULLIF(
        current_setting('opengeni.workspace_id', true), ''
      )::uuid;
      context_subject_id := NULLIF(
        current_setting('opengeni.subject_id', true), ''
      );
      context_principal_kind := NULLIF(
        current_setting('opengeni.principal_kind', true), ''
      );
      IF context_account_id IS NULL OR context_workspace_id IS NULL
        OR context_subject_id IS NULL
        OR context_principal_kind IS DISTINCT FROM 'human_session'
        OR p_actor_subject_id IS DISTINCT FROM context_subject_id
      THEN
        RAISE EXCEPTION 'preference lifecycle requires exact transaction-local actor authority'
          USING ERRCODE = '42501';
      END IF;
      IF length(btrim(p_actor_subject_id)) NOT BETWEEN 1 AND 1024
        OR length(btrim(p_reason)) NOT BETWEEN 1 AND 4096
      THEN
        RAISE EXCEPTION 'preference lifecycle actor and reason are invalid'
          USING ERRCODE = '22023';
      END IF;

      IF p_operation = 'supersede' THEN
        IF p_related_preference_id IS NULL OR p_related_preference_id = p_preference_id THEN
          RAISE EXCEPTION 'preference supersession requires a distinct replacement'
            USING ERRCODE = '22023';
        END IF;
        PERFORM 1
        FROM preference_registry_preferences candidate
        WHERE candidate.id IN (p_preference_id, p_related_preference_id)
          AND candidate.account_id = context_account_id
          AND opengeni_private.preference_registry_scope_visible(
            candidate.account_id,
            candidate.scope,
            candidate.scope_workspace_id,
            candidate.scope_subject_id
          )
        ORDER BY candidate.id
        FOR UPDATE;
        GET DIAGNOSTICS lifecycle_lock_count = ROW_COUNT;
        IF lifecycle_lock_count <> 2 THEN
          RAISE EXCEPTION 'preference supersession heads were not found in the authorized scope'
            USING ERRCODE = '42501';
        END IF;
      ELSE
        PERFORM 1
        FROM preference_registry_preferences candidate
        WHERE candidate.id = p_preference_id
          AND candidate.account_id = context_account_id
          AND opengeni_private.preference_registry_scope_visible(
            candidate.account_id,
            candidate.scope,
            candidate.scope_workspace_id,
            candidate.scope_subject_id
          )
        FOR UPDATE;
        GET DIAGNOSTICS lifecycle_lock_count = ROW_COUNT;
        IF lifecycle_lock_count <> 1 THEN
          RAISE EXCEPTION 'preference lifecycle head was not found in the authorized scope'
            USING ERRCODE = '42501';
        END IF;
      END IF;

      SELECT * INTO preference
      FROM preference_registry_preferences candidate
      WHERE candidate.id = p_preference_id
        AND candidate.account_id = context_account_id;
      IF NOT FOUND OR NOT opengeni_private.preference_registry_scope_visible(
        preference.account_id,
        preference.scope,
        preference.scope_workspace_id,
        preference.scope_subject_id
      ) THEN
        RAISE EXCEPTION 'preference was not found in the authorized scope'
          USING ERRCODE = '42501';
      END IF;
      IF preference.scope_version IS DISTINCT FROM p_expected_scope_version THEN
        RAISE EXCEPTION 'preference scope version changed'
          USING ERRCODE = '40001';
      END IF;
      IF preference.active_revision_id IS DISTINCT FROM p_expected_revision_id THEN
        RAISE EXCEPTION 'preference active revision changed'
          USING ERRCODE = '40001';
      END IF;
      PERFORM set_config(
        'opengeni.preference_lifecycle_head_id', preference.id::text, true
      );
      PERFORM set_config(
        'opengeni.preference_lifecycle_operation', p_operation, true
      );

      IF p_operation IN ('proposal_created', 'activate', 'correct', 'reject') THEN
        SELECT * INTO revision
        FROM preference_registry_revisions candidate
        WHERE candidate.id = p_revision_id
          AND candidate.preference_id = preference.id
          AND candidate.account_id = preference.account_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'preference lifecycle revision was not found'
            USING ERRCODE = '23503';
        END IF;
      END IF;

      IF p_operation = 'proposal_created' THEN
        IF preference.status <> 'proposed'
          OR preference.active_revision_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM preference_registry_events event
            WHERE event.preference_id = preference.id
          )
        THEN
          RAISE EXCEPTION 'proposal creation event requires a new inactive proposal'
            USING ERRCODE = '23514';
        END IF;
        event_type := 'proposal_created';
        new_revision_id := revision.id;
        new_scope := preference.scope;
        new_workspace_id := preference.scope_workspace_id;
        new_subject_id := preference.scope_subject_id;
      ELSIF p_operation = 'activate' THEN
        IF preference.status IN ('rejected', 'superseded')
          OR revision.id IS NOT DISTINCT FROM preference.active_revision_id
        THEN
          RAISE EXCEPTION 'preference cannot activate the requested revision'
            USING ERRCODE = '23514';
        END IF;
        UPDATE preference_registry_preferences
        SET status = 'active',
          active_revision_id = revision.id,
          active_revision = revision.revision,
          active_content_hash = revision.content_hash,
          activation_version = activation_version + 1,
          updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'activated';
        old_revision_id := preference.active_revision_id;
        new_revision_id := revision.id;
      ELSIF p_operation = 'correct' THEN
        IF preference.status IN ('rejected', 'superseded')
          OR preference.active_revision_id IS NULL
          OR revision.corrects_revision_id IS DISTINCT FROM preference.active_revision_id
          OR revision.provenance_source <> 'human'
        THEN
          RAISE EXCEPTION 'preference correction does not identify the active immutable revision'
            USING ERRCODE = '23514';
        END IF;
        UPDATE preference_registry_preferences
        SET status = 'active',
          active_revision_id = revision.id,
          active_revision = revision.revision,
          active_content_hash = revision.content_hash,
          activation_version = activation_version + 1,
          updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'corrected';
        old_revision_id := preference.active_revision_id;
        new_revision_id := revision.id;
      ELSIF p_operation = 'reject' THEN
        IF preference.status <> 'proposed' OR preference.active_revision_id IS NOT NULL THEN
          RAISE EXCEPTION 'only an inactive proposal can be rejected'
            USING ERRCODE = '23514';
        END IF;
        UPDATE preference_registry_preferences
        SET status = 'rejected', updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'rejected';
        new_revision_id := revision.id;
      ELSIF p_operation = 'deactivate' THEN
        IF preference.status <> 'active' OR preference.active_revision_id IS NULL THEN
          RAISE EXCEPTION 'only an active preference can be deactivated'
            USING ERRCODE = '23514';
        END IF;
        UPDATE preference_registry_preferences
        SET status = 'inactive', active_revision_id = NULL,
          active_revision = NULL, active_content_hash = NULL,
          activation_version = activation_version + 1,
          updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'deactivated';
        old_revision_id := preference.active_revision_id;
      ELSIF p_operation = 'scope' THEN
        IF preference.status IN ('rejected', 'superseded')
          OR p_new_scope NOT IN ('organization', 'workspace', 'user')
          OR p_new_scope = preference.scope
        THEN
          RAISE EXCEPTION 'preference cannot change to the requested scope'
            USING ERRCODE = '23514';
        END IF;
        old_scope := preference.scope;
        old_workspace_id := preference.scope_workspace_id;
        old_subject_id := preference.scope_subject_id;
        new_scope := p_new_scope;
        new_workspace_id := CASE WHEN p_new_scope = 'workspace'
          THEN context_workspace_id ELSE NULL END;
        new_subject_id := CASE WHEN p_new_scope = 'user'
          THEN context_subject_id ELSE NULL END;
        UPDATE preference_registry_preferences
        SET scope = new_scope,
          scope_workspace_id = new_workspace_id,
          scope_subject_id = new_subject_id,
          scope_version = scope_version + 1,
          updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'scope_changed';
      ELSIF p_operation = 'supersede' THEN
        SELECT * INTO replacement
        FROM preference_registry_preferences candidate
        WHERE candidate.id = p_related_preference_id
          AND candidate.account_id = preference.account_id;
        IF NOT FOUND
          OR replacement.status <> 'active'
          OR replacement.active_revision_id IS NULL
          OR replacement.scope IS DISTINCT FROM preference.scope
          OR replacement.scope_workspace_id IS DISTINCT FROM preference.scope_workspace_id
          OR replacement.scope_subject_id IS DISTINCT FROM preference.scope_subject_id
          OR NOT opengeni_private.preference_registry_scope_visible(
            replacement.account_id,
            replacement.scope,
            replacement.scope_workspace_id,
            replacement.scope_subject_id
          )
          OR preference.status <> 'active'
          OR preference.active_revision_id IS NULL
        THEN
          RAISE EXCEPTION 'replacement preference is not active in the exact same target'
            USING ERRCODE = '23514';
        END IF;
        SELECT * INTO replacement_revision
        FROM preference_registry_revisions candidate
        WHERE candidate.id = replacement.active_revision_id
          AND candidate.preference_id = replacement.id
          AND candidate.account_id = replacement.account_id
          AND (candidate.expires_at IS NULL OR candidate.expires_at > transaction_timestamp());
        IF NOT FOUND THEN
          RAISE EXCEPTION 'replacement preference active revision is expired'
            USING ERRCODE = '23514';
        END IF;
        UPDATE preference_registry_preferences
        SET status = 'superseded',
          superseded_by_preference_id = replacement.id,
          updated_at = clock_timestamp()
        WHERE id = preference.id;
        event_type := 'superseded';
        old_revision_id := preference.active_revision_id;
        related_preference_id := replacement.id;
      ELSE
        RAISE EXCEPTION 'unsupported preference lifecycle operation'
          USING ERRCODE = '22023';
      END IF;

      PERFORM set_config('opengeni.preference_lifecycle_head_id', '', true);
      PERFORM set_config('opengeni.preference_lifecycle_operation', '', true);

      SELECT COALESCE(max(event.version), 0) + 1 INTO next_event_version
      FROM preference_registry_events event
      WHERE event.preference_id = preference.id;
      INSERT INTO preference_registry_events (
        account_id, preference_id, type, version,
        old_revision_id, new_revision_id,
        old_scope, old_workspace_id, old_subject_id,
        new_scope, new_workspace_id, new_subject_id,
        related_preference_id, actor_subject_id, reason
      ) VALUES (
        preference.account_id, preference.id, event_type, next_event_version,
        old_revision_id, new_revision_id,
        old_scope, old_workspace_id, old_subject_id,
        new_scope, new_workspace_id, new_subject_id,
        related_preference_id, p_actor_subject_id, p_reason
      ) RETURNING id INTO event_id;
      RETURN NEXT;
    END
    $body$
  $ddl$, target_schema, target_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.preference_registry_apply_lifecycle(text, uuid, integer, uuid, uuid, text, uuid, text, text) FROM PUBLIC',
    target_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.preference_registry_apply_lifecycle(text, uuid, integer, uuid, uuid, text, uuid, text, text) TO opengeni_app',
      target_schema
    );
  END IF;
END $lifecycle_function$;

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
      'REVOKE ALL PRIVILEGES ON TABLE %I.preference_registry_preferences, %I.preference_registry_revisions, %I.preference_registry_events, %I.preference_registry_snapshots FROM opengeni_app',
      target_schema, target_schema, target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.preference_registry_preferences, %I.preference_registry_revisions TO opengeni_app',
      target_schema, target_schema
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.preference_registry_events, %I.preference_registry_snapshots TO opengeni_app',
      target_schema, target_schema
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %I.preference_registry_revision_seq TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;