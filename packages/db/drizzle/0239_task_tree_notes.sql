-- deployment-mode: rolling
-- Root-session task notes are an explicit, bounded coordination surface for
-- agents in one session tree. They are not prompt memory, company knowledge,
-- policy, preferences, or authority. All reads and writes pass through the
-- exact-attempt lifecycle functions below.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "task_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "text" text NOT NULL,
  "text_hash" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "create_operation_id" uuid NOT NULL,
  "create_input_hash" text NOT NULL,
  "created_by_actor_kind" text NOT NULL,
  "created_by_actor_subject_id" text NOT NULL,
  "created_by_initiating_human_subject_id" text,
  "created_by_session_id" uuid NOT NULL,
  "created_by_turn_id" uuid NOT NULL,
  "created_by_attempt_id" uuid NOT NULL,
  "created_by_execution_generation" integer NOT NULL,
  "archive_operation_id" uuid,
  "archive_input_hash" text,
  "archived_by_actor_kind" text,
  "archived_by_actor_subject_id" text,
  "archived_by_initiating_human_subject_id" text,
  "archived_by_session_id" uuid,
  "archived_by_turn_id" uuid,
  "archived_by_attempt_id" uuid,
  "archived_by_execution_generation" integer,
  "archived_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "task_notes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "task_notes_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_notes_created_by_session_fk"
    FOREIGN KEY ("workspace_id", "created_by_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_notes_created_by_turn_fk"
    FOREIGN KEY ("workspace_id", "created_by_turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_notes_created_by_attempt_fk"
    FOREIGN KEY ("workspace_id", "created_by_attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_notes_kind_check"
    CHECK ("kind" IN ('finding','decision','blocker','ownership','artifact','handoff')),
  CONSTRAINT "task_notes_text_check"
    CHECK (
      octet_length("text") BETWEEN 1 AND 4096
      AND "text" = btrim("text")
    ),
  CONSTRAINT "task_notes_text_hash_check"
    CHECK ("text_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_notes_status_check"
    CHECK ("status" IN ('active','archived')),
  CONSTRAINT "task_notes_version_check"
    CHECK ("version" BETWEEN 1 AND 2),
  CONSTRAINT "task_notes_expiry_check"
    CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'),
  CONSTRAINT "task_notes_create_hash_check"
    CHECK ("create_input_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_notes_create_actor_check"
    CHECK (
      "created_by_actor_kind" IN ('human','service')
      AND length("created_by_actor_subject_id") BETWEEN 1 AND 1024
      AND octet_length("created_by_actor_subject_id") <= 4096
      AND ("created_by_initiating_human_subject_id" IS NULL OR (
        length("created_by_initiating_human_subject_id") BETWEEN 1 AND 1024
        AND octet_length("created_by_initiating_human_subject_id") <= 4096
      ))
      AND "created_by_execution_generation" > 0
    ),
  CONSTRAINT "task_notes_archive_shape_check"
    CHECK (
      ("status" = 'active' AND "version" = 1
        AND "archive_operation_id" IS NULL
        AND "archive_input_hash" IS NULL
        AND "archived_by_actor_kind" IS NULL
        AND "archived_by_actor_subject_id" IS NULL
        AND "archived_by_initiating_human_subject_id" IS NULL
        AND "archived_by_session_id" IS NULL
        AND "archived_by_turn_id" IS NULL
        AND "archived_by_attempt_id" IS NULL
        AND "archived_by_execution_generation" IS NULL
        AND "archived_at" IS NULL)
      OR
      ("status" = 'archived' AND "version" = 2
        AND "archive_operation_id" IS NOT NULL
        AND "archive_input_hash" ~ '^[0-9a-f]{64}$'
        AND "archived_by_actor_kind" IN ('human','service')
        AND length("archived_by_actor_subject_id") BETWEEN 1 AND 1024
        AND octet_length("archived_by_actor_subject_id") <= 4096
        AND ("archived_by_initiating_human_subject_id" IS NULL OR (
          length("archived_by_initiating_human_subject_id") BETWEEN 1 AND 1024
          AND octet_length("archived_by_initiating_human_subject_id") <= 4096
        ))
        AND "archived_by_session_id" IS NOT NULL
        AND "archived_by_turn_id" IS NOT NULL
        AND "archived_by_attempt_id" IS NOT NULL
        AND "archived_by_execution_generation" > 0
        AND "archived_at" IS NOT NULL
        AND "archived_at" >= "created_at")
    )
);

CREATE UNIQUE INDEX "task_notes_workspace_id_uq"
  ON "task_notes" ("workspace_id", "id");
CREATE UNIQUE INDEX "task_notes_workspace_root_id_uq"
  ON "task_notes" ("workspace_id", "root_session_id", "id");
CREATE UNIQUE INDEX "task_notes_workspace_create_operation_uq"
  ON "task_notes" ("workspace_id", "create_operation_id");
CREATE UNIQUE INDEX "task_notes_workspace_archive_operation_uq"
  ON "task_notes" ("workspace_id", "archive_operation_id")
  WHERE "archive_operation_id" IS NOT NULL;
CREATE INDEX "task_notes_root_active_idx"
  ON "task_notes" ("workspace_id", "root_session_id", "status", "expires_at", "updated_at" DESC, "id" DESC);

CREATE TABLE "task_note_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "note_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "note_version" integer NOT NULL,
  "operation_id" uuid NOT NULL,
  "input_hash" text NOT NULL,
  "text_hash" text NOT NULL,
  "reason" text,
  "actor_kind" text NOT NULL,
  "actor_subject_id" text NOT NULL,
  "initiating_human_subject_id" text,
  "actor_session_id" uuid NOT NULL,
  "actor_turn_id" uuid NOT NULL,
  "actor_attempt_id" uuid NOT NULL,
  "actor_execution_generation" integer NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "task_note_events_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "task_note_events_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_note_events_note_fk"
    FOREIGN KEY ("workspace_id", "note_id")
    REFERENCES "task_notes" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "task_note_events_actor_session_fk"
    FOREIGN KEY ("workspace_id", "actor_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_events_actor_turn_fk"
    FOREIGN KEY ("workspace_id", "actor_turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_events_actor_attempt_fk"
    FOREIGN KEY ("workspace_id", "actor_attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "task_note_events_type_check"
    CHECK (("event_type" = 'created' AND "note_version" = 1 AND "reason" IS NULL)
      OR ("event_type" = 'archived' AND "note_version" = 2)),
  CONSTRAINT "task_note_events_hash_check"
    CHECK ("input_hash" ~ '^[0-9a-f]{64}$' AND "text_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_note_events_reason_check"
    CHECK ("reason" IS NULL OR (
      octet_length("reason") BETWEEN 1 AND 2048
    )),
  CONSTRAINT "task_note_events_actor_check"
    CHECK (
      "actor_kind" IN ('human','service')
      AND length("actor_subject_id") BETWEEN 1 AND 1024
      AND octet_length("actor_subject_id") <= 4096
      AND ("initiating_human_subject_id" IS NULL OR (
        length("initiating_human_subject_id") BETWEEN 1 AND 1024
        AND octet_length("initiating_human_subject_id") <= 4096
      ))
      AND "actor_execution_generation" > 0
    )
);

CREATE UNIQUE INDEX "task_note_events_workspace_operation_uq"
  ON "task_note_events" ("workspace_id", "operation_id");
CREATE UNIQUE INDEX "task_note_events_note_version_uq"
  ON "task_note_events" ("workspace_id", "note_id", "note_version");
CREATE INDEX "task_note_events_root_timeline_idx"
  ON "task_note_events" ("workspace_id", "root_session_id", "created_at", "id");

CREATE TABLE "task_note_write_capabilities" (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_id" uuid NOT NULL,
  PRIMARY KEY ("backend_pid", "transaction_id", "capability_id")
);

ALTER TABLE "task_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_notes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_note_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_note_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "task_note_write_capabilities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "task_note_write_capabilities" FORCE ROW LEVEL SECURITY;

DO $task_note_policies$
DECLARE
  data_schema text := current_schema();
  migration_owner text := current_user;
BEGIN
  EXECUTE format(
    'CREATE POLICY task_note_capability_owner ON %I.task_note_write_capabilities '
      || 'FOR ALL USING (current_user = %L) WITH CHECK (current_user = %L)',
    data_schema, migration_owner, migration_owner
  );
END
$task_note_policies$;

CREATE POLICY task_notes_tenant ON "task_notes"
  USING (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  )
  WITH CHECK (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  );
CREATE POLICY session_visibility_isolation ON "task_notes" AS RESTRICTIVE
  USING (session_reference_visible("account_id", "workspace_id", "root_session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "root_session_id"));
CREATE POLICY task_notes_lifecycle_only ON "task_notes" AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM "task_note_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "task_note_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ));

CREATE POLICY task_note_events_tenant ON "task_note_events"
  USING (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  )
  WITH CHECK (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  );
CREATE POLICY session_visibility_isolation ON "task_note_events" AS RESTRICTIVE
  USING (session_reference_visible("account_id", "workspace_id", "root_session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "root_session_id"));
CREATE POLICY task_note_events_lifecycle_only ON "task_note_events" AS RESTRICTIVE
  USING (EXISTS (
    SELECT 1 FROM "task_note_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM "task_note_write_capabilities" capability
    WHERE capability."backend_pid" = pg_backend_pid()
      AND capability."transaction_id" = pg_current_xact_id()
      AND capability."capability_id" = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ));

CREATE OR REPLACE FUNCTION guard_task_note_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  has_capability boolean;
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.root_session_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.created_by_session_id)
    )
  THEN
    RETURN OLD;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM task_note_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ) INTO has_capability;
  IF NOT has_capability THEN
    RAISE EXCEPTION 'task note mutation requires lifecycle authority'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task notes are archived, never deleted'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.text_hash <> encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex')
      OR NEW.status <> 'active'
      OR NEW.version <> 1
    THEN
      RAISE EXCEPTION 'task note create projection is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.root_session_id IS DISTINCT FROM OLD.root_session_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.text_hash IS DISTINCT FROM OLD.text_hash
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.create_operation_id IS DISTINCT FROM OLD.create_operation_id
    OR NEW.create_input_hash IS DISTINCT FROM OLD.create_input_hash
    OR NEW.created_by_actor_kind IS DISTINCT FROM OLD.created_by_actor_kind
    OR NEW.created_by_actor_subject_id IS DISTINCT FROM OLD.created_by_actor_subject_id
    OR NEW.created_by_initiating_human_subject_id IS DISTINCT FROM OLD.created_by_initiating_human_subject_id
    OR NEW.created_by_session_id IS DISTINCT FROM OLD.created_by_session_id
    OR NEW.created_by_turn_id IS DISTINCT FROM OLD.created_by_turn_id
    OR NEW.created_by_attempt_id IS DISTINCT FROM OLD.created_by_attempt_id
    OR NEW.created_by_execution_generation IS DISTINCT FROM OLD.created_by_execution_generation
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.status <> 'active'
    OR NEW.status <> 'archived'
    OR NEW.version <> OLD.version + 1
    OR NEW.updated_at <= OLD.updated_at
  THEN
    RAISE EXCEPTION 'task note update must be one active-to-archived transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_notes_guard_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "task_notes"
  FOR EACH ROW EXECUTE FUNCTION guard_task_note_mutation();

CREATE OR REPLACE FUNCTION guard_task_note_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  note_row task_notes%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.root_session_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE id = OLD.actor_session_id)
      OR NOT EXISTS (
        SELECT 1 FROM task_notes
        WHERE workspace_id = OLD.workspace_id AND id = OLD.note_id
      )
    )
  THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'task note events are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM task_note_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = nullif(
        current_setting('opengeni.task_note_write_capability', true), ''
      )::uuid
  ) THEN
    RAISE EXCEPTION 'task note event requires lifecycle authority'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT note_row FROM task_notes note
  WHERE note.workspace_id = NEW.workspace_id AND note.id = NEW.note_id;
  IF NEW.account_id IS DISTINCT FROM note_row.account_id
    OR NEW.root_session_id IS DISTINCT FROM note_row.root_session_id
    OR NEW.text_hash IS DISTINCT FROM note_row.text_hash
    OR NEW.note_version IS DISTINCT FROM note_row.version
    OR (NEW.event_type = 'created' AND (
      NEW.operation_id IS DISTINCT FROM note_row.create_operation_id
      OR NEW.input_hash IS DISTINCT FROM note_row.create_input_hash
      OR NEW.actor_kind IS DISTINCT FROM note_row.created_by_actor_kind
      OR NEW.actor_subject_id IS DISTINCT FROM note_row.created_by_actor_subject_id
      OR NEW.initiating_human_subject_id IS DISTINCT FROM note_row.created_by_initiating_human_subject_id
      OR NEW.actor_session_id IS DISTINCT FROM note_row.created_by_session_id
      OR NEW.actor_turn_id IS DISTINCT FROM note_row.created_by_turn_id
      OR NEW.actor_attempt_id IS DISTINCT FROM note_row.created_by_attempt_id
      OR NEW.actor_execution_generation IS DISTINCT FROM note_row.created_by_execution_generation
    ))
    OR (NEW.event_type = 'archived' AND (
      NEW.operation_id IS DISTINCT FROM note_row.archive_operation_id
      OR NEW.input_hash IS DISTINCT FROM note_row.archive_input_hash
      OR NEW.actor_kind IS DISTINCT FROM note_row.archived_by_actor_kind
      OR NEW.actor_subject_id IS DISTINCT FROM note_row.archived_by_actor_subject_id
      OR NEW.initiating_human_subject_id IS DISTINCT FROM note_row.archived_by_initiating_human_subject_id
      OR NEW.actor_session_id IS DISTINCT FROM note_row.archived_by_session_id
      OR NEW.actor_turn_id IS DISTINCT FROM note_row.archived_by_turn_id
      OR NEW.actor_attempt_id IS DISTINCT FROM note_row.archived_by_attempt_id
      OR NEW.actor_execution_generation IS DISTINCT FROM note_row.archived_by_execution_generation
    ))
  THEN
    RAISE EXCEPTION 'task note event does not match its durable note receipt'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER task_note_events_guard_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON "task_note_events"
  FOR EACH ROW EXECUTE FUNCTION guard_task_note_event_mutation();

CREATE OR REPLACE FUNCTION resolve_task_note_attempt_authority(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer
) RETURNS TABLE (
  root_session_id uuid,
  actor_kind text,
  actor_subject_id text,
  initiating_human_subject_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  resolved_root_id uuid;
  turn_row session_turns%ROWTYPE;
  previous_subject_id text := pg_catalog.current_setting('opengeni.subject_id', true);
  previous_initiating_human_subject_id text := pg_catalog.current_setting(
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
    RAISE EXCEPTION 'task notes require exact tenant and attempt authority'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM workspaces workspace
  WHERE workspace.account_id = p_account_id AND workspace.id = p_workspace_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task note workspace is unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT session.root_session_id INTO resolved_root_id
  FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id;
  IF resolved_root_id IS NULL THEN
    RAISE EXCEPTION 'task note session is unavailable' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_workspace_id
    AND session.id IN (p_session_id, resolved_root_id)
  ORDER BY session.id
  -- Root authority serializes sibling mutations, including the active-record
  -- cap check. UUID order preserves the canonical multi-session lock order.
  FOR UPDATE;
  IF (SELECT count(*) FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_workspace_id
        AND session.id IN (p_session_id, resolved_root_id))
      <> (CASE WHEN p_session_id = resolved_root_id THEN 1 ELSE 2 END)
  THEN
    RAISE EXCEPTION 'task note root session is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT turn.* INTO turn_row
  FROM session_turns turn
  JOIN sessions session ON session.account_id = turn.account_id
    AND session.workspace_id = turn.workspace_id
    AND session.id = turn.session_id
  WHERE turn.account_id = p_account_id
    AND turn.workspace_id = p_workspace_id
    AND turn.session_id = p_session_id
    AND turn.id = p_turn_id
    AND turn.active_attempt_id = p_attempt_id
    AND session.active_turn_id = p_turn_id
    AND turn.execution_generation = p_execution_generation
    AND turn.status IN ('running','requires_action','recovering','waiting_capacity')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'task notes require the exact current turn' USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'task notes require the exact current attempt' USING ERRCODE = '42501';
  END IF;

  -- A worker connection is transport, not session-visibility authority. Recheck
  -- the private root and addressed session under the immutable human authority
  -- frozen on the accepted logical turn, then restore the caller's GUCs. Pure
  -- service work deliberately supplies no manufactured human identity.
  PERFORM pg_catalog.set_config(
    'opengeni.subject_id',
    CASE WHEN turn_row.initiator_kind = 'subject'
      THEN turn_row.initiator_subject_id ELSE '' END,
    true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(turn_row.initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := true;
  IF (SELECT count(*) FROM sessions session
      WHERE session.account_id = p_account_id
        AND session.workspace_id = p_workspace_id
        AND session.id IN (p_session_id, resolved_root_id)
        AND (
          session.visibility = 'workspace_shared'
          OR session_private_actor_visible(
            session.account_id,
            session.workspace_id,
            session.owner_organization_membership_id,
            session.owner_subject_id
          )
        )) <> (CASE WHEN p_session_id = resolved_root_id THEN 1 ELSE 2 END)
  THEN
    RAISE EXCEPTION 'task note session tree is not visible to this actor'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.subject_id', COALESCE(previous_subject_id, ''), true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(previous_initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := false;

  root_session_id := resolved_root_id;
  actor_kind := CASE turn_row.initiator_kind WHEN 'subject' THEN 'human' ELSE 'service' END;
  actor_subject_id := turn_row.initiator_subject_id;
  initiating_human_subject_id := turn_row.initiating_human_subject_id;
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  IF visibility_context_set THEN
    PERFORM pg_catalog.set_config(
      'opengeni.subject_id', COALESCE(previous_subject_id, ''), true
    );
    PERFORM pg_catalog.set_config(
      'opengeni.initiating_human_subject_id',
      COALESCE(previous_initiating_human_subject_id, ''),
      true
    );
  END IF;
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION create_task_note_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_kind text,
  p_text text,
  p_expires_in_days integer
) RETURNS TABLE (
  note_id uuid, root_session_id uuid, kind text, note_text text, status text,
  version integer, expires_at timestamptz, created_at timestamptz,
  updated_at timestamptz, archived_at timestamptz, actor_kind text,
  source_session_id uuid, source_turn_id uuid, replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  authority record;
  existing_event task_note_events%ROWTYPE;
  note_row task_notes%ROWTYPE;
  calculated_text_hash text;
  calculated_input_hash text;
  calculated_expires_at timestamptz;
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting('opengeni.task_note_write_capability', true);
BEGIN
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL
    OR p_kind NOT IN ('finding','decision','blocker','ownership','artifact','handoff')
    OR p_text IS NULL OR octet_length(p_text) NOT BETWEEN 1 AND 4096
    OR p_text <> btrim(p_text)
    OR p_expires_in_days IS NULL OR p_expires_in_days NOT BETWEEN 1 AND 30
  THEN
    RAISE EXCEPTION 'task note input is invalid' USING ERRCODE = '22023';
  END IF;
  calculated_expires_at := transaction_timestamp()
    + pg_catalog.make_interval(days => p_expires_in_days);
  calculated_text_hash := encode(sha256(convert_to(p_text, 'UTF8')), 'hex');
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'rootSessionId', authority.root_session_id, 'sessionId', p_session_id,
    'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'kind', p_kind,
    'textHash', calculated_text_hash, 'expiresInDays', p_expires_in_days
  )::text, 'UTF8')), 'hex');

  INSERT INTO task_note_write_capabilities (backend_pid, transaction_id, capability_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config('opengeni.task_note_write_capability', write_capability_id::text, true);

  SELECT * INTO existing_event FROM task_note_events event
  WHERE event.workspace_id = p_workspace_id AND event.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_event.event_type <> 'created'
      OR existing_event.input_hash <> calculated_input_hash
      OR existing_event.root_session_id <> authority.root_session_id
      OR existing_event.actor_session_id <> p_session_id
      OR existing_event.actor_turn_id <> p_turn_id
      OR existing_event.actor_attempt_id <> p_attempt_id
      OR existing_event.actor_execution_generation <> p_execution_generation
    THEN
      RAISE EXCEPTION 'task note operation conflicts with another input or attempt'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO STRICT note_row FROM task_notes note
    WHERE note.workspace_id = p_workspace_id AND note.id = existing_event.note_id;
    replayed := true;
  ELSE
    IF (SELECT count(*) FROM task_notes note
        WHERE note.workspace_id = p_workspace_id
          AND note.root_session_id = authority.root_session_id
          AND note.status = 'active' AND note.expires_at > transaction_timestamp()) >= 500
    THEN
      RAISE EXCEPTION 'task note active-record limit reached' USING ERRCODE = '54000';
    END IF;
    INSERT INTO task_notes (
      account_id, workspace_id, root_session_id, kind, text, text_hash,
      expires_at, create_operation_id, create_input_hash,
      created_by_actor_kind, created_by_actor_subject_id,
      created_by_initiating_human_subject_id, created_by_session_id,
      created_by_turn_id, created_by_attempt_id, created_by_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id, p_kind, p_text,
      calculated_text_hash, calculated_expires_at, p_operation_id, calculated_input_hash,
      authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    ) RETURNING * INTO note_row;
    INSERT INTO task_note_events (
      account_id, workspace_id, root_session_id, note_id, event_type,
      note_version, operation_id, input_hash, text_hash, actor_kind,
      actor_subject_id, initiating_human_subject_id, actor_session_id,
      actor_turn_id, actor_attempt_id, actor_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id, note_row.id,
      'created', 1, p_operation_id, calculated_input_hash,
      calculated_text_hash, authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    );
    replayed := false;
  END IF;

  note_id := note_row.id; root_session_id := note_row.root_session_id;
  kind := note_row.kind; note_text := note_row.text; status := note_row.status;
  version := note_row.version; expires_at := note_row.expires_at;
  created_at := note_row.created_at; updated_at := note_row.updated_at;
  archived_at := note_row.archived_at; actor_kind := note_row.created_by_actor_kind;
  source_session_id := note_row.created_by_session_id;
  source_turn_id := note_row.created_by_turn_id;
  DELETE FROM task_note_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION archive_task_note_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_operation_id uuid,
  p_note_id uuid,
  p_expected_version integer,
  p_reason text
) RETURNS TABLE (
  note_id uuid, root_session_id uuid, kind text, note_text text, status text,
  version integer, expires_at timestamptz, created_at timestamptz,
  updated_at timestamptz, archived_at timestamptz, actor_kind text,
  source_session_id uuid, source_turn_id uuid, replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  authority record;
  existing_event task_note_events%ROWTYPE;
  note_row task_notes%ROWTYPE;
  calculated_input_hash text;
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting('opengeni.task_note_write_capability', true);
BEGIN
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_operation_id IS NULL OR p_note_id IS NULL OR p_expected_version <> 1
    OR p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 2048
    OR p_reason <> btrim(p_reason)
  THEN
    RAISE EXCEPTION 'task note archive input is invalid' USING ERRCODE = '22023';
  END IF;
  calculated_input_hash := encode(sha256(convert_to(jsonb_build_object(
    'accountId', p_account_id, 'workspaceId', p_workspace_id,
    'rootSessionId', authority.root_session_id, 'sessionId', p_session_id,
    'turnId', p_turn_id, 'attemptId', p_attempt_id,
    'executionGeneration', p_execution_generation, 'noteId', p_note_id,
    'expectedVersion', p_expected_version, 'reason', p_reason
  )::text, 'UTF8')), 'hex');

  INSERT INTO task_note_write_capabilities (backend_pid, transaction_id, capability_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config('opengeni.task_note_write_capability', write_capability_id::text, true);

  SELECT * INTO existing_event FROM task_note_events event
  WHERE event.workspace_id = p_workspace_id AND event.operation_id = p_operation_id
  FOR SHARE;
  IF FOUND THEN
    IF existing_event.event_type <> 'archived'
      OR existing_event.input_hash <> calculated_input_hash
      OR existing_event.root_session_id <> authority.root_session_id
      OR existing_event.actor_session_id <> p_session_id
      OR existing_event.actor_turn_id <> p_turn_id
      OR existing_event.actor_attempt_id <> p_attempt_id
      OR existing_event.actor_execution_generation <> p_execution_generation
    THEN
      RAISE EXCEPTION 'task note archive operation conflicts with another input or attempt'
        USING ERRCODE = '23505';
    END IF;
    SELECT * INTO STRICT note_row FROM task_notes note
    WHERE note.workspace_id = p_workspace_id AND note.id = existing_event.note_id;
    replayed := true;
  ELSE
    SELECT * INTO note_row FROM task_notes note
    WHERE note.workspace_id = p_workspace_id
      AND note.root_session_id = authority.root_session_id
      AND note.id = p_note_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'task note is unavailable' USING ERRCODE = 'P0002';
    END IF;
    IF note_row.status <> 'active' OR note_row.version <> p_expected_version THEN
      RAISE EXCEPTION 'task note archive version conflict' USING ERRCODE = '40001';
    END IF;
    UPDATE task_notes note SET
      status = 'archived', version = note.version + 1,
      archive_operation_id = p_operation_id,
      archive_input_hash = calculated_input_hash,
      archived_by_actor_kind = authority.actor_kind,
      archived_by_actor_subject_id = authority.actor_subject_id,
      archived_by_initiating_human_subject_id = authority.initiating_human_subject_id,
      archived_by_session_id = p_session_id,
      archived_by_turn_id = p_turn_id,
      archived_by_attempt_id = p_attempt_id,
      archived_by_execution_generation = p_execution_generation,
      archived_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE note.workspace_id = p_workspace_id AND note.id = p_note_id
      AND note.status = 'active' AND note.version = p_expected_version
    RETURNING * INTO STRICT note_row;
    INSERT INTO task_note_events (
      account_id, workspace_id, root_session_id, note_id, event_type,
      note_version, operation_id, input_hash, text_hash, reason, actor_kind,
      actor_subject_id, initiating_human_subject_id, actor_session_id,
      actor_turn_id, actor_attempt_id, actor_execution_generation
    ) VALUES (
      p_account_id, p_workspace_id, authority.root_session_id, note_row.id,
      'archived', note_row.version, p_operation_id, calculated_input_hash,
      note_row.text_hash, p_reason, authority.actor_kind, authority.actor_subject_id,
      authority.initiating_human_subject_id, p_session_id, p_turn_id,
      p_attempt_id, p_execution_generation
    );
    replayed := false;
  END IF;

  note_id := note_row.id; root_session_id := note_row.root_session_id;
  kind := note_row.kind; note_text := note_row.text; status := note_row.status;
  version := note_row.version; expires_at := note_row.expires_at;
  created_at := note_row.created_at; updated_at := note_row.updated_at;
  archived_at := note_row.archived_at; actor_kind := note_row.created_by_actor_kind;
  source_session_id := note_row.created_by_session_id;
  source_turn_id := note_row.created_by_turn_id;
  DELETE FROM task_note_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION list_task_notes_for_attempt(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer,
  p_include_archived boolean DEFAULT false,
  p_limit integer DEFAULT 10
) RETURNS TABLE (
  note_id uuid, root_session_id uuid, kind text, note_text text, status text,
  version integer, expires_at timestamptz, created_at timestamptz,
  updated_at timestamptz, archived_at timestamptz, actor_kind text,
  source_session_id uuid, source_turn_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  authority record;
  write_capability_id uuid := gen_random_uuid();
  previous_capability text := current_setting('opengeni.task_note_write_capability', true);
BEGIN
  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );
  IF p_include_archived IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'task note list input is invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO task_note_write_capabilities (backend_pid, transaction_id, capability_id)
  VALUES (pg_backend_pid(), pg_current_xact_id(), write_capability_id);
  PERFORM set_config('opengeni.task_note_write_capability', write_capability_id::text, true);
  RETURN QUERY
    SELECT note.id, note.root_session_id, note.kind, note.text, note.status,
      note.version, note.expires_at, note.created_at, note.updated_at,
      note.archived_at, note.created_by_actor_kind, note.created_by_session_id,
      note.created_by_turn_id
    FROM task_notes note
    WHERE note.account_id = p_account_id
      AND note.workspace_id = p_workspace_id
      AND note.root_session_id = authority.root_session_id
      AND note.expires_at > transaction_timestamp()
      AND (p_include_archived OR note.status = 'active')
    ORDER BY note.updated_at DESC, note.id DESC
    LIMIT p_limit;
  DELETE FROM task_note_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = write_capability_id;
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
  RAISE;
END;
$$;

REVOKE ALL ON "task_notes" FROM PUBLIC;
REVOKE ALL ON "task_note_events" FROM PUBLIC;
REVOKE ALL ON "task_note_write_capabilities" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_task_note_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_task_note_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_task_note_attempt_authority(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION archive_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION list_task_notes_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,boolean,integer) FROM PUBLIC;

DO $task_note_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON "task_notes" FROM opengeni_app;
    REVOKE ALL ON "task_note_events" FROM opengeni_app;
    REVOKE ALL ON "task_note_write_capabilities" FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION create_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION archive_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION list_task_notes_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,boolean,integer) TO opengeni_app;
  END IF;
END
$task_note_runtime_grants$;

COMMENT ON TABLE "task_notes" IS
  'Bounded, expiring, non-authoritative root-session coordination notes. Never auto-composed into prompts.';
COMMENT ON TABLE "task_note_events" IS
  'Immutable exact-attempt create/archive receipts for task notes; values never confer authority.';
COMMENT ON FUNCTION create_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,text,integer) IS
  'Creates one task-tree note under exact current-attempt authority; operation replay is bound to root, attempt, and canonical input hash.';
COMMENT ON FUNCTION archive_task_note_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,uuid,uuid,integer,text) IS
  'Archives one task-tree note with immutable separate archive provenance; the create receipt remains unchanged.';
COMMENT ON FUNCTION list_task_notes_for_attempt(uuid,uuid,uuid,uuid,uuid,integer,boolean,integer) IS
  'Explicit bounded task-tree note retrieval under exact current-attempt and root-session visibility authority.';
