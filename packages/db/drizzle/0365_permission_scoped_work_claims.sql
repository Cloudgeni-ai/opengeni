-- deployment-mode: rolling
-- Durable, non-exclusive work claims for permission-scoped discovery. Claims
-- are evidence only: they grant no authority, acquire no lock/lease, and never
-- block another session from claiming the same typed subject.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- Freeze the active data schema into every SECURITY DEFINER routine. This is
-- public for standalone installs and the host-selected schema when embedded.
SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.format('%I, pg_catalog, pg_temp', pg_catalog.current_schema()),
  true
);

CREATE TABLE "session_work_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "subject_namespace" text NOT NULL,
  "subject_type" text NOT NULL,
  "canonical_key" text NOT NULL,
  "subject_digest" text NOT NULL,
  "display_label" text,
  "role" text NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "provenance" text NOT NULL,
  "version_kind" text,
  "version_value" text,
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "settled_at" timestamptz,
  CONSTRAINT "session_work_claims_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claims_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claims_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claims_namespace_check" CHECK (
    "subject_namespace" = lower(btrim("subject_namespace"))
    AND octet_length("subject_namespace") BETWEEN 1 AND 64
    AND "subject_namespace" ~ '^[a-z0-9]([a-z0-9._:-]{0,62}[a-z0-9])?$'
  ),
  CONSTRAINT "session_work_claims_type_check" CHECK (
    "subject_type" IN (
      'repository','branch','pull_request','issue','artifact','release','ci_run','other'
    )
  ),
  CONSTRAINT "session_work_claims_key_check" CHECK (
    "canonical_key" = btrim("canonical_key")
    AND "canonical_key" = normalize("canonical_key", NFKC)
    AND octet_length("canonical_key") BETWEEN 1 AND 512
    AND "canonical_key" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "session_work_claims_digest_check" CHECK (
    "subject_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "session_work_claims_label_check" CHECK (
    "display_label" IS NULL OR (
      "display_label" = btrim("display_label")
      AND "display_label" = normalize("display_label", NFKC)
      AND octet_length("display_label") BETWEEN 1 AND 256
      AND "display_label" !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT "session_work_claims_role_check" CHECK (
    "role" IN ('working','reviewing','monitoring','delivering')
  ),
  CONSTRAINT "session_work_claims_state_check" CHECK (
    "state" IN ('active','released','superseded','stale')
  ),
  CONSTRAINT "session_work_claims_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "session_work_claims_provenance_check" CHECK (
    "provenance" IN (
      'explicit_agent','user_api','trusted_integration','session_resource','system_lifecycle'
    )
  ),
  CONSTRAINT "session_work_claims_version_check" CHECK (
    ("version_kind" IS NULL AND "version_value" IS NULL)
    OR (
      "version_kind" IN (
        'git_commit','branch_head','pull_request_head','artifact_version',
        'release_version','ci_run','other'
      )
      AND "version_value" = btrim("version_value")
      AND "version_value" = normalize("version_value", NFKC)
      AND octet_length("version_value") BETWEEN 1 AND 256
      AND "version_value" !~ '[[:cntrl:]]'
    )
  ),
  CONSTRAINT "session_work_claims_lifecycle_check" CHECK (
    ("state" = 'active' AND "settled_at" IS NULL)
    OR ("state" <> 'active' AND "settled_at" IS NOT NULL)
  ),
  CONSTRAINT "session_work_claims_timestamp_check" CHECK (
    "observed_at" >= "created_at"
    AND "updated_at" >= "observed_at"
    AND ("settled_at" IS NULL OR "settled_at" >= "created_at")
  )
);

CREATE UNIQUE INDEX "session_work_claims_workspace_id_uq"
  ON "session_work_claims" ("workspace_id", "id");
CREATE UNIQUE INDEX "session_work_claims_active_identity_uq"
  ON "session_work_claims" (
    "workspace_id", "session_id", "subject_namespace", "subject_type", "subject_digest", "role"
  ) WHERE "state" = 'active';
CREATE INDEX "session_work_claims_session_state_idx"
  ON "session_work_claims" (
    "workspace_id", "session_id", "state", "updated_at" DESC, "id" DESC
  );
CREATE INDEX "session_work_claims_subject_state_idx"
  ON "session_work_claims" (
    "workspace_id", "subject_namespace", "subject_type", "subject_digest", "state",
    "updated_at" DESC, "id" DESC
  );

CREATE TABLE "session_work_claim_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "claim_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "mutation_kind" text NOT NULL,
  "prior_revision" integer,
  "resulting_revision" integer NOT NULL,
  "subject_namespace" text NOT NULL,
  "subject_type" text NOT NULL,
  "canonical_key" text NOT NULL,
  "subject_digest" text NOT NULL,
  "display_label" text,
  "role" text NOT NULL,
  "state" text NOT NULL,
  "provenance" text NOT NULL,
  "version_kind" text,
  "version_value" text,
  "observed_at" timestamptz NOT NULL,
  "claim_created_at" timestamptz NOT NULL,
  "claim_updated_at" timestamptz NOT NULL,
  "settled_at" timestamptz,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "actor_session_id" uuid,
  "actor_turn_id" uuid,
  "actor_attempt_id" uuid,
  "actor_execution_generation" integer,
  "reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "session_work_claim_revisions_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claim_revisions_claim_fk"
    FOREIGN KEY ("workspace_id", "claim_id")
    REFERENCES "session_work_claims" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claim_revisions_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claim_revisions_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_work_claim_revisions_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_work_claim_revisions_actor_turn_fk"
    FOREIGN KEY ("workspace_id", "actor_turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_work_claim_revisions_actor_attempt_fk"
    FOREIGN KEY ("workspace_id", "actor_attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "session_work_claim_revisions_hash_check" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$' AND "subject_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "session_work_claim_revisions_mutation_check" CHECK (
    "mutation_kind" IN ('created','updated','released','superseded','stale')
    AND (("mutation_kind" = 'created' AND "prior_revision" IS NULL AND "resulting_revision" = 1)
      OR ("mutation_kind" <> 'created' AND "prior_revision" > 0
        AND "resulting_revision" = "prior_revision" + 1))
  ),
  CONSTRAINT "session_work_claim_revisions_actor_check" CHECK (
    "actor_kind" IN ('agent_attempt','human','integration','system')
    AND octet_length("actor_subject_id") BETWEEN 1 AND 4096
    AND (
      ("actor_kind" = 'agent_attempt'
        AND "actor_session_id" IS NOT NULL
        AND "actor_turn_id" IS NOT NULL
        AND "actor_attempt_id" IS NOT NULL
        AND "actor_execution_generation" > 0)
      OR
      ("actor_kind" <> 'agent_attempt'
        AND "actor_attempt_id" IS NULL
        AND "actor_execution_generation" IS NULL)
    )
  ),
  CONSTRAINT "session_work_claim_revisions_reason_check" CHECK (
    "reason" IS NULL OR "reason" IN (
      'completed','cancelled','failed','superseded','no_longer_active',
      'corrected','external_state_changed','other'
    )
  )
);

CREATE UNIQUE INDEX "session_work_claim_revisions_workspace_operation_uq"
  ON "session_work_claim_revisions" ("workspace_id", "operation_id");
CREATE UNIQUE INDEX "session_work_claim_revisions_claim_revision_uq"
  ON "session_work_claim_revisions" ("workspace_id", "claim_id", "resulting_revision");
CREATE INDEX "session_work_claim_revisions_session_timeline_idx"
  ON "session_work_claim_revisions" (
    "workspace_id", "session_id", "created_at" DESC, "id" DESC
  );

CREATE TABLE "session_work_claim_write_capabilities" (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_id" uuid NOT NULL,
  PRIMARY KEY ("backend_pid", "transaction_id", "capability_id")
);

ALTER TABLE "session_work_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_work_claims" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_work_claim_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_work_claim_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_work_claim_write_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_work_claim_write_capabilities" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION opengeni_private.session_work_claim_capability_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
  SELECT EXISTS (
    SELECT 1 FROM session_work_claim_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id_if_assigned()
      AND capability.capability_id = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  )
$$;
REVOKE ALL ON FUNCTION opengeni_private.session_work_claim_capability_active() FROM PUBLIC;

DO $work_claim_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY session_work_claim_capability_owner ON %I.session_work_claim_write_capabilities '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
END
$work_claim_policies$;

CREATE POLICY session_work_claims_tenant ON "session_work_claims"
  USING (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  )
  WITH CHECK (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  );
CREATE POLICY session_visibility_isolation ON "session_work_claims" AS RESTRICTIVE
  FOR SELECT
  USING (
    session_reference_visible("account_id", "workspace_id", "session_id")
    OR opengeni_private.session_work_claim_capability_active()
  )
  ;
CREATE POLICY session_work_claims_lifecycle_insert ON "session_work_claims" AS RESTRICTIVE
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM "session_work_claim_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ));
CREATE POLICY session_work_claims_lifecycle_update ON "session_work_claims" AS RESTRICTIVE
  FOR UPDATE USING (EXISTS (
    SELECT 1 FROM "session_work_claim_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM "session_work_claim_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ));
CREATE POLICY session_work_claims_lifecycle_delete ON "session_work_claims" AS RESTRICTIVE
  FOR DELETE USING (EXISTS (
    SELECT 1 FROM "session_work_claim_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ));

CREATE POLICY session_work_claim_revisions_tenant ON "session_work_claim_revisions"
  USING (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  )
  WITH CHECK (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  );
CREATE POLICY session_visibility_isolation ON "session_work_claim_revisions" AS RESTRICTIVE
  FOR SELECT
  USING (
    session_reference_visible("account_id", "workspace_id", "session_id")
    OR opengeni_private.session_work_claim_capability_active()
  )
  ;
CREATE POLICY session_work_claim_revisions_lifecycle_insert
  ON "session_work_claim_revisions" AS RESTRICTIVE
  FOR INSERT WITH CHECK (EXISTS (
    SELECT 1 FROM "session_work_claim_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ));
CREATE POLICY session_work_claim_revisions_immutable_update
  ON "session_work_claim_revisions" AS RESTRICTIVE
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY session_work_claim_revisions_immutable_delete
  ON "session_work_claim_revisions" AS RESTRICTIVE
  FOR DELETE USING (false);

CREATE OR REPLACE FUNCTION session_work_claim_subject_digest(
  p_namespace text, p_type text, p_canonical_key text
) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path FROM CURRENT
AS $$
  SELECT encode(sha256(convert_to(
    p_namespace || chr(31) || p_type || chr(31) || p_canonical_key,
    'UTF8'
  )), 'hex')
$$;

CREATE OR REPLACE FUNCTION guard_session_work_claim_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  has_capability boolean;
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
    )
  THEN
    RETURN OLD;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM session_work_claim_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ) INTO has_capability;
  IF NOT has_capability THEN
    RAISE EXCEPTION 'work claim mutation requires lifecycle authority'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'work claims are settled, never deleted'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.subject_digest <> session_work_claim_subject_digest(
    NEW.subject_namespace, NEW.subject_type, NEW.canonical_key
  ) THEN
    RAISE EXCEPTION 'work claim subject digest is invalid' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'active' OR NEW.revision <> 1 OR NEW.settled_at IS NOT NULL THEN
      RAISE EXCEPTION 'work claim create projection is invalid' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.session_id IS DISTINCT FROM OLD.session_id
    OR NEW.root_session_id IS DISTINCT FROM OLD.root_session_id
    OR NEW.subject_namespace IS DISTINCT FROM OLD.subject_namespace
    OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
    OR NEW.canonical_key IS DISTINCT FROM OLD.canonical_key
    OR NEW.subject_digest IS DISTINCT FROM OLD.subject_digest
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state <> 'active'
    OR NEW.revision <> OLD.revision + 1
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'work claim update violates immutable identity or revision fencing'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'active' THEN
    IF NEW.settled_at IS NOT NULL OR NEW.observed_at < OLD.observed_at THEN
      RAISE EXCEPTION 'active work claim refresh is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state IN ('released','superseded','stale') THEN
    IF NEW.settled_at IS NULL
      OR NEW.display_label IS DISTINCT FROM OLD.display_label
      OR NEW.version_kind IS DISTINCT FROM OLD.version_kind
      OR NEW.version_value IS DISTINCT FROM OLD.version_value
      OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
    THEN
      RAISE EXCEPTION 'work claim settlement may only change lifecycle fields'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'work claim state transition is invalid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_work_claims_guard_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "session_work_claims"
  FOR EACH ROW EXECUTE FUNCTION guard_session_work_claim_mutation();

CREATE OR REPLACE FUNCTION guard_session_work_claim_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  claim_row session_work_claims%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.session_id)
      OR NOT EXISTS (
        SELECT 1 FROM session_work_claims
        WHERE workspace_id = OLD.workspace_id AND id = OLD.claim_id
      )
    )
  THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'work claim revisions are immutable' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM session_work_claim_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = nullif(
        current_setting('opengeni.session_work_claim_write_capability', true), ''
      )::uuid
  ) THEN
    RAISE EXCEPTION 'work claim revision requires lifecycle authority'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT claim_row FROM session_work_claims claim
  WHERE claim.workspace_id = NEW.workspace_id AND claim.id = NEW.claim_id;
  IF NEW.account_id IS DISTINCT FROM claim_row.account_id
    OR NEW.session_id IS DISTINCT FROM claim_row.session_id
    OR NEW.root_session_id IS DISTINCT FROM claim_row.root_session_id
    OR NEW.resulting_revision IS DISTINCT FROM claim_row.revision
    OR NEW.subject_namespace IS DISTINCT FROM claim_row.subject_namespace
    OR NEW.subject_type IS DISTINCT FROM claim_row.subject_type
    OR NEW.canonical_key IS DISTINCT FROM claim_row.canonical_key
    OR NEW.subject_digest IS DISTINCT FROM claim_row.subject_digest
    OR NEW.display_label IS DISTINCT FROM claim_row.display_label
    OR NEW.role IS DISTINCT FROM claim_row.role
    OR NEW.state IS DISTINCT FROM claim_row.state
    OR NEW.provenance IS DISTINCT FROM claim_row.provenance
    OR NEW.version_kind IS DISTINCT FROM claim_row.version_kind
    OR NEW.version_value IS DISTINCT FROM claim_row.version_value
    OR NEW.observed_at IS DISTINCT FROM claim_row.observed_at
    OR NEW.claim_created_at IS DISTINCT FROM claim_row.created_at
    OR NEW.claim_updated_at IS DISTINCT FROM claim_row.updated_at
    OR NEW.settled_at IS DISTINCT FROM claim_row.settled_at
  THEN
    RAISE EXCEPTION 'work claim revision does not match its durable head receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_work_claim_revisions_guard_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "session_work_claim_revisions"
  FOR EACH ROW EXECUTE FUNCTION guard_session_work_claim_revision_mutation();

CREATE OR REPLACE FUNCTION resolve_session_work_claim_attempt_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer
) RETURNS TABLE (
  root_session_id uuid,
  actor_subject_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  session_row sessions%ROWTYPE;
  turn_row session_turns%ROWTYPE;
  previous_subject_id text := current_setting('opengeni.subject_id', true);
  previous_initiating_human_subject_id text := current_setting(
    'opengeni.initiating_human_subject_id', true
  );
  visibility_context_set boolean := false;
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_turn_id IS NULL OR p_attempt_id IS NULL
    OR p_execution_generation IS NULL OR p_execution_generation < 1
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'work claims require exact tenant and attempt authority'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work claim workspace is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO session_row FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id
  FOR NO KEY UPDATE;
  IF NOT FOUND OR session_row.status IN ('failed','cancelled') THEN
    RAISE EXCEPTION 'work claim session is unavailable' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM session_goals goal
    WHERE goal.account_id = p_account_id
      AND goal.workspace_id = p_workspace_id
      AND goal.session_id = p_session_id
      AND goal.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'completed session goals cannot create or mutate work claims'
      USING ERRCODE = '42501';
  END IF;

  SELECT turn.* INTO turn_row FROM session_turns turn
  WHERE turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.id = p_turn_id
    AND turn.active_attempt_id = p_attempt_id
    AND session_row.active_turn_id = p_turn_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running','requires_action','recovering','waiting_capacity')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work claims require the exact current turn' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM session_turn_attempts attempt
  WHERE attempt.account_id = p_account_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.session_id = p_session_id
    AND attempt.turn_id = p_turn_id
    AND attempt.id = p_attempt_id
    AND attempt.execution_generation = p_execution_generation
    AND attempt.state IN ('claimed','running')
    AND NOT EXISTS (
      SELECT 1 FROM session_attempt_interruptions interruption
      WHERE interruption.workspace_id = attempt.workspace_id
        AND interruption.attempt_id = attempt.id
        AND interruption.state IN ('pending','delivered','acknowledged')
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'work claims require the exact current attempt' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config(
    'opengeni.subject_id',
    CASE WHEN turn_row.initiator_kind = 'subject' THEN turn_row.initiator_subject_id ELSE '' END,
    true
  );
  PERFORM set_config(
    'opengeni.initiating_human_subject_id',
    coalesce(turn_row.initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := true;
  IF NOT (
    session_row.visibility = 'workspace_shared'
    OR session_private_actor_visible(
      session_row.account_id,
      session_row.workspace_id,
      session_row.owner_organization_membership_id,
      session_row.owner_subject_id
    )
  ) THEN
    RAISE EXCEPTION 'work claim session is not visible to this actor'
      USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.subject_id', coalesce(previous_subject_id, ''), true);
  PERFORM set_config(
    'opengeni.initiating_human_subject_id',
    coalesce(previous_initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := false;

  root_session_id := session_row.root_session_id;
  actor_subject_id := turn_row.initiator_subject_id;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  IF visibility_context_set THEN
    PERFORM set_config('opengeni.subject_id', coalesce(previous_subject_id, ''), true);
    PERFORM set_config(
      'opengeni.initiating_human_subject_id',
      coalesce(previous_initiating_human_subject_id, ''),
      true
    );
  END IF;
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION upsert_session_work_claim_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_expected_revision integer,
  p_subject_namespace text,
  p_subject_type text,
  p_canonical_key text,
  p_display_label text,
  p_role text,
  p_version_kind text,
  p_version_value text
) RETURNS TABLE (
  claim_id uuid, session_id uuid, root_session_id uuid,
  subject_namespace text, subject_type text, canonical_key text,
  display_label text, role text, state text, revision integer,
  provenance text, version_kind text, version_value text,
  observed_at timestamptz, created_at timestamptz, updated_at timestamptz,
  settled_at timestamptz, mutation_kind text, replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  existing_revision session_work_claim_revisions%ROWTYPE;
  claim_row session_work_claims%ROWTYPE;
  calculated_digest text;
  calculated_input_hash text;
  mutation_value text;
  now_value timestamptz := clock_timestamp();
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting(
    'opengeni.session_work_claim_write_capability', true
  );
BEGIN
  PERFORM acquire_session_tenancy_fence(p_workspace_id);
  SELECT * INTO STRICT authority FROM resolve_session_work_claim_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR p_subject_namespace IS NULL
    OR p_subject_namespace <> lower(btrim(p_subject_namespace))
    OR octet_length(p_subject_namespace) NOT BETWEEN 1 AND 64
    OR p_subject_namespace !~ '^[a-z0-9]([a-z0-9._:-]{0,62}[a-z0-9])?$'
    OR p_subject_type NOT IN (
      'repository','branch','pull_request','issue','artifact','release','ci_run','other'
    )
    OR p_canonical_key IS NULL OR p_canonical_key <> btrim(p_canonical_key)
    OR p_canonical_key <> normalize(p_canonical_key, NFKC)
    OR octet_length(p_canonical_key) NOT BETWEEN 1 AND 512
    OR p_canonical_key ~ '[[:cntrl:]]'
    OR (p_display_label IS NOT NULL AND (
      p_display_label <> btrim(p_display_label)
      OR p_display_label <> normalize(p_display_label, NFKC)
      OR octet_length(p_display_label) NOT BETWEEN 1 AND 256
      OR p_display_label ~ '[[:cntrl:]]'
    ))
    OR p_role NOT IN ('working','reviewing','monitoring','delivering')
    OR ((p_version_kind IS NULL) <> (p_version_value IS NULL))
    OR (p_version_kind IS NOT NULL AND (
      p_version_kind NOT IN (
        'git_commit','branch_head','pull_request_head','artifact_version',
        'release_version','ci_run','other'
      )
      OR p_version_value <> btrim(p_version_value)
      OR p_version_value <> normalize(p_version_value, NFKC)
      OR octet_length(p_version_value) NOT BETWEEN 1 AND 256
      OR p_version_value ~ '[[:cntrl:]]'
    ))
  THEN
    RAISE EXCEPTION 'work claim upsert input is invalid' USING ERRCODE = '22023';
  END IF;

  calculated_digest := session_work_claim_subject_digest(
    p_subject_namespace, p_subject_type, p_canonical_key
  );
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id,
    'workspaceId', p_workspace_id,
    'sessionId', p_session_id,
    'turnId', p_turn_id,
    'expectedRevision', p_expected_revision,
    'subjectNamespace', p_subject_namespace,
    'subjectType', p_subject_type,
    'canonicalKey', p_canonical_key,
    'displayLabel', p_display_label,
    'role', p_role,
    'versionKind', p_version_kind,
    'versionValue', p_version_value
  )::text, 'UTF8')), 'hex');

  INSERT INTO session_work_claim_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', write_capability_id::text, true
  );

  SELECT * INTO existing_revision FROM session_work_claim_revisions revision_row
  WHERE revision_row.workspace_id = p_workspace_id
    AND revision_row.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_revision.input_hash <> calculated_input_hash
      OR existing_revision.session_id <> p_session_id
      OR existing_revision.actor_turn_id <> p_turn_id
      OR existing_revision.mutation_kind NOT IN ('created','updated')
    THEN
      RAISE EXCEPTION 'work claim operation conflicts with another input or logical turn'
        USING ERRCODE = '23505';
    END IF;
    claim_row.id := existing_revision.claim_id;
    claim_row.session_id := existing_revision.session_id;
    claim_row.root_session_id := existing_revision.root_session_id;
    claim_row.subject_namespace := existing_revision.subject_namespace;
    claim_row.subject_type := existing_revision.subject_type;
    claim_row.canonical_key := existing_revision.canonical_key;
    claim_row.display_label := existing_revision.display_label;
    claim_row.role := existing_revision.role;
    claim_row.state := existing_revision.state;
    claim_row.revision := existing_revision.resulting_revision;
    claim_row.provenance := existing_revision.provenance;
    claim_row.version_kind := existing_revision.version_kind;
    claim_row.version_value := existing_revision.version_value;
    claim_row.observed_at := existing_revision.observed_at;
    claim_row.created_at := existing_revision.claim_created_at;
    claim_row.updated_at := existing_revision.claim_updated_at;
    claim_row.settled_at := existing_revision.settled_at;
    mutation_value := existing_revision.mutation_kind;
    replayed := true;
  ELSE
    SELECT * INTO claim_row FROM session_work_claims claim
    WHERE claim.workspace_id = p_workspace_id
      AND claim.session_id = p_session_id
      AND claim.subject_namespace = p_subject_namespace
      AND claim.subject_type = p_subject_type
      AND claim.subject_digest = calculated_digest
      AND claim.role = p_role
      AND claim.state = 'active'
    FOR UPDATE;
    IF FOUND THEN
      IF claim_row.revision <> p_expected_revision THEN
        RAISE EXCEPTION 'work claim upsert revision conflict' USING ERRCODE = '40001';
      END IF;
      UPDATE session_work_claims claim SET
        display_label = p_display_label,
        version_kind = p_version_kind,
        version_value = p_version_value,
        observed_at = now_value,
        revision = claim.revision + 1,
        updated_at = now_value
      WHERE claim.workspace_id = p_workspace_id
        AND claim.id = claim_row.id
        AND claim.state = 'active'
        AND claim.revision = p_expected_revision
      RETURNING * INTO STRICT claim_row;
      mutation_value := 'updated';
    ELSE
      IF p_expected_revision <> 0 THEN
        RAISE EXCEPTION 'work claim create revision conflict' USING ERRCODE = '40001';
      END IF;
      IF (SELECT count(*) FROM session_work_claims claim
          WHERE claim.workspace_id = p_workspace_id
            AND claim.session_id = p_session_id
            AND claim.state = 'active') >= 64
      THEN
        RAISE EXCEPTION 'work claim active-record limit reached' USING ERRCODE = '54000';
      END IF;
      INSERT INTO session_work_claims (
        account_id, workspace_id, session_id, root_session_id,
        subject_namespace, subject_type, canonical_key, subject_digest,
        display_label, role, provenance, version_kind, version_value,
        observed_at, created_at, updated_at
      ) VALUES (
        p_account_id, p_workspace_id, p_session_id, authority.root_session_id,
        p_subject_namespace, p_subject_type, p_canonical_key, calculated_digest,
        p_display_label, p_role, 'explicit_agent', p_version_kind, p_version_value,
        now_value, now_value, now_value
      ) RETURNING * INTO claim_row;
      mutation_value := 'created';
    END IF;

    INSERT INTO session_work_claim_revisions (
      account_id, workspace_id, claim_id, session_id, root_session_id,
      operation_id, input_hash, mutation_kind, prior_revision, resulting_revision,
      subject_namespace, subject_type, canonical_key, subject_digest, display_label,
      role, state, provenance, version_kind, version_value, observed_at,
      claim_created_at, claim_updated_at, settled_at, actor_kind, actor_subject_id,
      actor_session_id, actor_turn_id, actor_attempt_id, actor_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, claim_row.id, p_session_id, claim_row.root_session_id,
      p_operation_id, calculated_input_hash, mutation_value,
      CASE WHEN mutation_value = 'created' THEN NULL ELSE p_expected_revision END,
      claim_row.revision, claim_row.subject_namespace, claim_row.subject_type,
      claim_row.canonical_key, claim_row.subject_digest, claim_row.display_label,
      claim_row.role, claim_row.state, claim_row.provenance, claim_row.version_kind,
      claim_row.version_value, claim_row.observed_at, claim_row.created_at,
      claim_row.updated_at, claim_row.settled_at, 'agent_attempt', authority.actor_subject_id,
      p_session_id, p_turn_id, p_attempt_id, p_execution_generation
    );
    UPDATE sessions session SET updated_at = now_value
    WHERE session.workspace_id = p_workspace_id AND session.id = p_session_id;
    replayed := false;
  END IF;

  claim_id := claim_row.id;
  session_id := claim_row.session_id;
  root_session_id := claim_row.root_session_id;
  subject_namespace := claim_row.subject_namespace;
  subject_type := claim_row.subject_type;
  canonical_key := claim_row.canonical_key;
  display_label := claim_row.display_label;
  role := claim_row.role;
  state := claim_row.state;
  revision := claim_row.revision;
  provenance := claim_row.provenance;
  version_kind := claim_row.version_kind;
  version_value := claim_row.version_value;
  observed_at := claim_row.observed_at;
  created_at := claim_row.created_at;
  updated_at := claim_row.updated_at;
  settled_at := claim_row.settled_at;
  mutation_kind := mutation_value;
  DELETE FROM session_work_claim_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION release_session_work_claim_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_claim_id uuid,
  p_expected_revision integer,
  p_reason text
) RETURNS TABLE (
  claim_id uuid, session_id uuid, root_session_id uuid,
  subject_namespace text, subject_type text, canonical_key text,
  display_label text, role text, state text, revision integer,
  provenance text, version_kind text, version_value text,
  observed_at timestamptz, created_at timestamptz, updated_at timestamptz,
  settled_at timestamptz, mutation_kind text, replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  existing_revision session_work_claim_revisions%ROWTYPE;
  claim_row session_work_claims%ROWTYPE;
  calculated_input_hash text;
  now_value timestamptz := clock_timestamp();
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting(
    'opengeni.session_work_claim_write_capability', true
  );
BEGIN
  PERFORM acquire_session_tenancy_fence(p_workspace_id);
  SELECT * INTO STRICT authority FROM resolve_session_work_claim_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL OR p_claim_id IS NULL
    OR p_expected_revision IS NULL OR p_expected_revision < 1
    OR p_reason NOT IN (
      'completed','cancelled','failed','superseded','no_longer_active',
      'corrected','external_state_changed','other'
    )
  THEN
    RAISE EXCEPTION 'work claim release input is invalid' USING ERRCODE = '22023';
  END IF;
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id,
    'workspaceId', p_workspace_id,
    'sessionId', p_session_id,
    'turnId', p_turn_id,
    'claimId', p_claim_id,
    'expectedRevision', p_expected_revision,
    'reason', p_reason
  )::text, 'UTF8')), 'hex');

  INSERT INTO session_work_claim_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', write_capability_id::text, true
  );

  SELECT * INTO existing_revision FROM session_work_claim_revisions revision_row
  WHERE revision_row.workspace_id = p_workspace_id
    AND revision_row.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_revision.input_hash <> calculated_input_hash
      OR existing_revision.session_id <> p_session_id
      OR existing_revision.actor_turn_id <> p_turn_id
      OR existing_revision.mutation_kind <> 'released'
    THEN
      RAISE EXCEPTION 'work claim release conflicts with another input or logical turn'
        USING ERRCODE = '23505';
    END IF;
    claim_row.id := existing_revision.claim_id;
    claim_row.session_id := existing_revision.session_id;
    claim_row.root_session_id := existing_revision.root_session_id;
    claim_row.subject_namespace := existing_revision.subject_namespace;
    claim_row.subject_type := existing_revision.subject_type;
    claim_row.canonical_key := existing_revision.canonical_key;
    claim_row.display_label := existing_revision.display_label;
    claim_row.role := existing_revision.role;
    claim_row.state := existing_revision.state;
    claim_row.revision := existing_revision.resulting_revision;
    claim_row.provenance := existing_revision.provenance;
    claim_row.version_kind := existing_revision.version_kind;
    claim_row.version_value := existing_revision.version_value;
    claim_row.observed_at := existing_revision.observed_at;
    claim_row.created_at := existing_revision.claim_created_at;
    claim_row.updated_at := existing_revision.claim_updated_at;
    claim_row.settled_at := existing_revision.settled_at;
    replayed := true;
  ELSE
    SELECT * INTO claim_row FROM session_work_claims claim
    WHERE claim.workspace_id = p_workspace_id
      AND claim.session_id = p_session_id
      AND claim.id = p_claim_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'work claim is unavailable' USING ERRCODE = 'P0002';
    END IF;
    IF claim_row.state <> 'active' OR claim_row.revision <> p_expected_revision THEN
      RAISE EXCEPTION 'work claim release revision conflict' USING ERRCODE = '40001';
    END IF;
    UPDATE session_work_claims claim SET
      state = 'released',
      revision = claim.revision + 1,
      settled_at = now_value,
      updated_at = now_value
    WHERE claim.workspace_id = p_workspace_id
      AND claim.id = p_claim_id
      AND claim.state = 'active'
      AND claim.revision = p_expected_revision
    RETURNING * INTO STRICT claim_row;
    INSERT INTO session_work_claim_revisions (
      account_id, workspace_id, claim_id, session_id, root_session_id,
      operation_id, input_hash, mutation_kind, prior_revision, resulting_revision,
      subject_namespace, subject_type, canonical_key, subject_digest, display_label,
      role, state, provenance, version_kind, version_value, observed_at,
      claim_created_at, claim_updated_at, settled_at, actor_kind, actor_subject_id,
      actor_session_id, actor_turn_id, actor_attempt_id, actor_execution_generation, reason
    ) VALUES (
      p_account_id, p_workspace_id, claim_row.id, p_session_id, claim_row.root_session_id,
      p_operation_id, calculated_input_hash, 'released', p_expected_revision,
      claim_row.revision, claim_row.subject_namespace, claim_row.subject_type,
      claim_row.canonical_key, claim_row.subject_digest, claim_row.display_label,
      claim_row.role, claim_row.state, claim_row.provenance, claim_row.version_kind,
      claim_row.version_value, claim_row.observed_at, claim_row.created_at,
      claim_row.updated_at, claim_row.settled_at, 'agent_attempt', authority.actor_subject_id,
      p_session_id, p_turn_id, p_attempt_id, p_execution_generation, p_reason
    );
    UPDATE sessions session SET updated_at = now_value
    WHERE session.workspace_id = p_workspace_id AND session.id = p_session_id;
    replayed := false;
  END IF;

  claim_id := claim_row.id;
  session_id := claim_row.session_id;
  root_session_id := claim_row.root_session_id;
  subject_namespace := claim_row.subject_namespace;
  subject_type := claim_row.subject_type;
  canonical_key := claim_row.canonical_key;
  display_label := claim_row.display_label;
  role := claim_row.role;
  state := claim_row.state;
  revision := claim_row.revision;
  provenance := claim_row.provenance;
  version_kind := claim_row.version_kind;
  version_value := claim_row.version_value;
  observed_at := claim_row.observed_at;
  created_at := claim_row.created_at;
  updated_at := claim_row.updated_at;
  settled_at := claim_row.settled_at;
  mutation_kind := 'released';
  DELETE FROM session_work_claim_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION settle_active_session_work_claims(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_state text,
  p_reason text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  claim_row session_work_claims%ROWTYPE;
  now_value timestamptz := clock_timestamp();
  settled_count integer := 0;
  write_capability_id uuid := gen_random_uuid();
  previous_account_id text := current_setting('opengeni.account_id', true);
  previous_workspace_id text := current_setting('opengeni.workspace_id', true);
  previous_capability text := current_setting(
    'opengeni.session_work_claim_write_capability', true
  );
BEGIN
  IF p_state NOT IN ('released','superseded','stale')
    OR p_reason NOT IN ('completed','cancelled','failed','superseded')
  THEN
    RAISE EXCEPTION 'work claim lifecycle settlement is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM set_config('opengeni.account_id', p_account_id::text, true);
  PERFORM set_config('opengeni.workspace_id', p_workspace_id::text, true);
  INSERT INTO session_work_claim_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', write_capability_id::text, true
  );
  FOR claim_row IN
    SELECT * FROM session_work_claims claim
    WHERE claim.account_id = p_account_id
      AND claim.workspace_id = p_workspace_id
      AND claim.session_id = p_session_id
      AND claim.state = 'active'
    ORDER BY claim.id
    FOR UPDATE
  LOOP
    UPDATE session_work_claims claim SET
      state = p_state,
      revision = claim.revision + 1,
      settled_at = now_value,
      updated_at = now_value
    WHERE claim.workspace_id = p_workspace_id
      AND claim.id = claim_row.id
      AND claim.state = 'active'
      AND claim.revision = claim_row.revision
    RETURNING * INTO STRICT claim_row;
    INSERT INTO session_work_claim_revisions (
      account_id, workspace_id, claim_id, session_id, root_session_id,
      operation_id, input_hash, mutation_kind, prior_revision, resulting_revision,
      subject_namespace, subject_type, canonical_key, subject_digest, display_label,
      role, state, provenance, version_kind, version_value, observed_at,
      claim_created_at, claim_updated_at, settled_at, actor_kind, actor_subject_id,
      reason
    ) VALUES (
      claim_row.account_id, claim_row.workspace_id, claim_row.id,
      claim_row.session_id, claim_row.root_session_id, gen_random_uuid(),
      encode(sha256(convert_to(jsonb_build_object(
        'claimId', claim_row.id,
        'priorRevision', claim_row.revision - 1,
        'state', p_state,
        'reason', p_reason
      )::text, 'UTF8')), 'hex'),
      p_state, claim_row.revision - 1, claim_row.revision,
      claim_row.subject_namespace, claim_row.subject_type, claim_row.canonical_key,
      claim_row.subject_digest, claim_row.display_label, claim_row.role, claim_row.state,
      claim_row.provenance, claim_row.version_kind, claim_row.version_value,
      claim_row.observed_at, claim_row.created_at, claim_row.updated_at,
      claim_row.settled_at, 'system', 'system:lifecycle', p_reason
    );
    settled_count := settled_count + 1;
  END LOOP;
  DELETE FROM session_work_claim_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  PERFORM set_config('opengeni.account_id', coalesce(previous_account_id, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace_id, ''), true);
  RETURN settled_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.session_work_claim_write_capability', coalesce(previous_capability, ''), true
  );
  PERFORM set_config('opengeni.account_id', coalesce(previous_account_id, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace_id, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION settle_session_work_claims_on_session_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled' THEN
    PERFORM settle_active_session_work_claims(
      NEW.account_id, NEW.workspace_id, NEW.id, 'released', 'cancelled'
    );
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'failed' THEN
    PERFORM settle_active_session_work_claims(
      NEW.account_id, NEW.workspace_id, NEW.id, 'stale', 'failed'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_settle_work_claims_terminal
  AFTER UPDATE OF "status" ON "sessions"
  FOR EACH ROW
  WHEN (NEW."status" IS DISTINCT FROM OLD."status")
  EXECUTE FUNCTION settle_session_work_claims_on_session_terminal();

CREATE OR REPLACE FUNCTION settle_session_work_claims_on_goal_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'completed' THEN
    PERFORM settle_active_session_work_claims(
      NEW.account_id, NEW.workspace_id, NEW.session_id, 'released', 'completed'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER session_goals_settle_work_claims_completed
  AFTER UPDATE OF "status" ON "session_goals"
  FOR EACH ROW
  WHEN (NEW."status" IS DISTINCT FROM OLD."status" AND NEW."status" = 'completed')
  EXECUTE FUNCTION settle_session_work_claims_on_goal_completion();

DO $work_claim_search_paths$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.session_work_claim_capability_active() '
      || 'SET search_path = %I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.session_work_claim_subject_digest(text,text,text) '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.guard_session_work_claim_mutation() '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.guard_session_work_claim_revision_mutation() '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.resolve_session_work_claim_attempt_authority(uuid,uuid,uuid,uuid,uuid,integer) '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.upsert_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text,text,text,text,text) '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.release_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.settle_active_session_work_claims(uuid,uuid,uuid,text,text) '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.settle_session_work_claims_on_session_terminal() '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.settle_session_work_claims_on_goal_completion() '
      || 'SET search_path = %1$I, pg_catalog', data_schema
  );
END
$work_claim_search_paths$;

REVOKE ALL ON "session_work_claims" FROM PUBLIC;
REVOKE ALL ON "session_work_claim_revisions" FROM PUBLIC;
REVOKE ALL ON "session_work_claim_write_capabilities" FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.session_work_claim_capability_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION session_work_claim_subject_digest(text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_session_work_claim_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_session_work_claim_revision_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_session_work_claim_attempt_authority(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_session_work_claim_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_active_session_work_claims(uuid,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_session_work_claims_on_session_terminal() FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_session_work_claims_on_goal_completion() FROM PUBLIC;

DO $work_claim_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON "session_work_claims" FROM opengeni_app;
    REVOKE ALL ON "session_work_claim_revisions" FROM opengeni_app;
    REVOKE ALL ON "session_work_claim_write_capabilities" FROM opengeni_app;
    GRANT SELECT ON "session_work_claims" TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.session_work_claim_capability_active()
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION upsert_session_work_claim_for_attempt(
      uuid,uuid,uuid,uuid,uuid,integer,uuid,integer,text,text,text,text,text,text,text
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION release_session_work_claim_for_attempt(
      uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text
    ) TO opengeni_app;
  END IF;
END
$work_claim_runtime_grants$;
