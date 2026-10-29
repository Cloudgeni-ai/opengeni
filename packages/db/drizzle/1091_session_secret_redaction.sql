-- deployment-mode: rolling
-- Scrubbing secrets out of stored session history (docs/secrets.md, "Removing
-- secrets from stored history").
--
-- A workspace admin can rewrite every stored copy of a leaked secret in chosen
-- sessions. The API reads and rewrites most session tables under the caller's
-- row-level security, as any writer does. A few copies sit where the runtime
-- role cannot read or change them on purpose: goal text and goal revisions
-- (an UPDATE would advance the objective revision, and revisions are
-- immutable), the goal snapshot a turn froze, task notes, the message search
-- mirror, model-request content blobs, MCP operation results, the host export
-- outbox, the model-history repair audit and the manifest of an archived
-- session. This migration adds two owner routines for exactly those cells:
--
-- * session_secret_redaction_rows_v1 reads the text of the four tables the
--   runtime cannot read at all, one bounded page at a time;
-- * redact_session_secret_cells_v1 writes replacement text into an allowlisted
--   cell, only when the cell still holds what the caller read (compare and
--   swap on its md5), resyncs the message search mirror from its event,
--   deletes a content blob no snapshot or catalog refers to any more, and
--   swaps an archived session's manifest to rewritten objects (queueing the
--   old objects for deletion).
--
-- Neither routine decides what a secret is: matching happens in the API, and
-- the routines only accept text for cells it names. Both require the caller's
-- RLS workspace scope to be the workspace they act on, and the owner still
-- passes each table's row-level security.
--
-- The guards that keep those cells immutable for every other writer get one
-- narrow exception each, for an UPDATE made inside these routines (the
-- transaction-local marker opengeni.session_secret_redaction = 'v1' and the
-- table owner as current_user; the task-note guard, itself a definer, checks
-- a fixed write capability only these routines insert). The read-only guard of
-- archived and imported sessions lets an UPDATE through under the marker
-- alone, so the API can rewrite the turns and model history those sessions
-- keep; it still refuses every insert.
--
-- Both routines are created with their runtime EXECUTE withheld for one
-- release: the previous release does not know them and rejects a runtime grant
-- on an unknown SECURITY DEFINER routine. Until a later migration grants them,
-- the API checks the grant first and reports these cells as pending.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- The schema owner may resync a search row to its event (see the writer).
CREATE POLICY session_message_search_owner_update ON "session_message_search_texts"
  FOR UPDATE
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_message_search_texts'::regclass
    )
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_message_search_texts'::regclass
    )
  );

-- Whether this transaction is inside one of the two routines below: the
-- transaction-local marker plus the routine's own capability row, which only
-- the routines insert (the runtime cannot write task_note_write_capabilities)
-- and which lives for one backend and one transaction. Every guard exception
-- below asks this after checking the marker and the table owner, so a marker
-- set by anyone else, or another owner routine running after it, is not
-- enough.
DO $writer$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_secret_redaction_writer_v1()
    RETURNS boolean
    LANGUAGE sql STABLE SET search_path = pg_catalog, %1$I, pg_temp AS $body$
      SELECT coalesce(current_setting('opengeni.session_secret_redaction', true) = 'v1', false)
        AND EXISTS (
          SELECT 1 FROM %1$I.task_note_write_capabilities capability
          WHERE capability.backend_pid = pg_backend_pid()
            AND capability.transaction_id = pg_current_xact_id()
            AND capability.capability_id = '5ec7e7ed-0988-4000-8000-5ec7e7ed0988'::uuid)
    $body$;
  $create$, data_schema);
END $writer$;
REVOKE ALL ON FUNCTION opengeni_private.session_secret_redaction_writer_v1() FROM PUBLIC;

-- Whether p_new is p_old with some spans replaced by `[redacted: <label>]`
-- markers, and nothing else changed. The cell writer below accepts only such
-- a value, so it can remove text but never put other text into a record that
-- is otherwise immutable. Greedy leftmost placement of the unchanged pieces
-- decides it exactly.
CREATE FUNCTION opengeni_private.session_secret_redaction_shape_v1(p_old text, p_new text)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $body$
DECLARE
  pieces text[];
  piece text;
  piece_count integer;
  cursor_at integer;
  found_at integer;
  index_value integer;
BEGIN
  IF p_old IS NULL OR p_new IS NULL THEN
    RETURN false;
  END IF;
  IF p_old = p_new THEN
    RETURN true;
  END IF;
  -- A marker's label never holds "]", so "+" stops at its own closing bracket.
  -- "+" rather than a counted {1,300}: PostgreSQL rejects counts above 255.
  pieces := regexp_split_to_array(p_new, '\[redacted: [^]\r\n"\\]+\]');
  piece_count := coalesce(array_length(pieces, 1), 0);
  IF piece_count < 2 THEN
    RETURN false;
  END IF;
  IF left(p_old, length(pieces[1])) IS DISTINCT FROM pieces[1] THEN
    RETURN false;
  END IF;
  cursor_at := length(pieces[1]) + 1;
  FOR index_value IN 2 .. piece_count - 1 LOOP
    piece := pieces[index_value];
    CONTINUE WHEN piece = '';
    found_at := strpos(substr(p_old, cursor_at), piece);
    IF found_at = 0 THEN
      RETURN false;
    END IF;
    cursor_at := cursor_at + found_at - 1 + length(piece);
  END LOOP;
  piece := pieces[piece_count];
  RETURN length(p_old) - length(piece) + 1 >= cursor_at
    AND right(p_old, length(piece)) = piece;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.session_secret_redaction_shape_v1(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION session_goal_revision_reject_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Parent lifecycle deletion is the sole mutation exception. PostgreSQL's
  -- cascading constraint trigger runs only after its parent row is absent;
  -- require both nested trigger context and one missing ownership edge so
  -- direct or unrelated-trigger deletes remain fail-closed.
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM "managed_accounts" WHERE "id" = OLD."account_id")
      OR NOT EXISTS (SELECT 1 FROM "workspaces" WHERE "id" = OLD."workspace_id")
      OR NOT EXISTS (SELECT 1 FROM "sessions" WHERE "id" = OLD."session_id")
    )
  THEN
    RETURN OLD;
  END IF;
  -- 1091: the secret scrub rewrites revision text inside its owner routine.
  IF TG_OP = 'UPDATE'
    AND current_setting('opengeni.session_secret_redaction', true) = 'v1'
  THEN
    IF current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
    ) THEN
      IF opengeni_private.session_secret_redaction_writer_v1() THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION 'session goal revisions are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE OR REPLACE FUNCTION session_goal_revision_before_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  semantic_change boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF octet_length(NEW."text") > 8192 THEN
      RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."success_criteria" IS NOT NULL
      AND octet_length(NEW."success_criteria") > 8192 THEN
      RAISE EXCEPTION 'goal success criteria exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."objective_revision" <> 1 THEN
      RAISE EXCEPTION 'a new goal must start at objective revision 1'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- 1091: a secret scrub keeps the objective revision; the same text minus
  -- the secret is not a new objective. The length limits still hold (a marker
  -- can be longer than the value it replaces).
  IF current_setting('opengeni.session_secret_redaction', true) = 'v1'
    AND NEW."objective_revision" = OLD."objective_revision"
  THEN
    IF current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
    ) THEN
      IF opengeni_private.session_secret_redaction_writer_v1() THEN
        IF octet_length(NEW."text") > 8192
          OR octet_length(coalesce(NEW."success_criteria", '')) > 8192
        THEN
          RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
            USING ERRCODE = '22001';
        END IF;
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  semantic_change :=
    NEW."text" IS DISTINCT FROM OLD."text"
    OR NEW."success_criteria" IS DISTINCT FROM OLD."success_criteria"
    OR NEW."root_constraints" IS DISTINCT FROM OLD."root_constraints"
    OR NEW."mutation_policy" IS DISTINCT FROM OLD."mutation_policy";

  IF semantic_change THEN
    IF octet_length(NEW."text") > 8192 THEN
      RAISE EXCEPTION 'goal text exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."success_criteria" IS NOT NULL
      AND octet_length(NEW."success_criteria") > 8192 THEN
      RAISE EXCEPTION 'goal success criteria exceeds 8192 UTF-8 bytes'
        USING ERRCODE = '22001';
    END IF;
    IF NEW."objective_revision" = OLD."objective_revision" THEN
      NEW."objective_revision" := OLD."objective_revision" + 1;
    ELSIF NEW."objective_revision" <> OLD."objective_revision" + 1 THEN
      RAISE EXCEPTION 'goal objective revision must advance exactly once'
        USING ERRCODE = '40001';
    END IF;
  ELSIF NEW."objective_revision" <> OLD."objective_revision" THEN
    RAISE EXCEPTION 'goal objective revision changed without semantic content'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION session_goal_revision_after_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  semantic_change boolean := TG_OP = 'INSERT';
  base_revision integer := 0;
  change_kind text := 'replacement';
  change_rationale text := 'Goal created';
  change_actor text;
  change_turn_id uuid;
  change_attempt_id uuid;
  source_proposal_id uuid;
  rollback_revision_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- 1091: a secret scrub records no revision (see the before trigger).
    IF current_setting('opengeni.session_secret_redaction', true) = 'v1'
      AND NEW."objective_revision" = OLD."objective_revision"
    THEN
      IF current_user = (
        SELECT pg_catalog.pg_get_userbyid(relation.relowner)
        FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
      ) THEN
        IF opengeni_private.session_secret_redaction_writer_v1() THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    semantic_change :=
      NEW."text" IS DISTINCT FROM OLD."text"
      OR NEW."success_criteria" IS DISTINCT FROM OLD."success_criteria"
      OR NEW."root_constraints" IS DISTINCT FROM OLD."root_constraints"
      OR NEW."mutation_policy" IS DISTINCT FROM OLD."mutation_policy";
    base_revision := OLD."objective_revision";
    change_rationale := 'Goal changed by a rolling-compatible writer';
  END IF;
  IF NOT semantic_change THEN
    RETURN NEW;
  END IF;

  change_kind := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_kind', true), ''),
    change_kind
  );
  change_rationale := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_rationale', true), ''),
    change_rationale
  );
  change_actor := COALESCE(
    NULLIF(current_setting('opengeni.goal_change_actor', true), ''),
    CASE
      WHEN NEW."created_by" = 'scheduled_task' THEN 'scheduled_task'
      WHEN NEW."created_by" = 'agent' THEN 'agent'
      ELSE 'api'
    END
  );
  change_turn_id := NULLIF(
    current_setting('opengeni.goal_change_turn_id', true), ''
  )::uuid;
  change_attempt_id := NULLIF(
    current_setting('opengeni.goal_change_attempt_id', true), ''
  )::uuid;
  source_proposal_id := NULLIF(
    current_setting('opengeni.goal_change_proposal_id', true), ''
  )::uuid;
  rollback_revision_id := NULLIF(
    current_setting('opengeni.goal_change_rollback_of_revision_id', true), ''
  )::uuid;

  INSERT INTO "session_goal_revisions" (
    "account_id", "workspace_id", "session_id", "goal_id", "disposition",
    "change_kind", "base_objective_revision", "result_objective_revision",
    "text", "success_criteria", "root_constraints", "mutation_policy",
    "rationale", "actor", "actor_turn_id", "actor_attempt_id", "proposal_id",
    "rollback_of_revision_id", "created_at"
  ) VALUES (
    NEW."account_id", NEW."workspace_id", NEW."session_id", NEW."id",
    'applied', change_kind, base_revision, NEW."objective_revision", NEW."text",
    NEW."success_criteria", NEW."root_constraints", NEW."mutation_policy",
    change_rationale, change_actor, change_turn_id, change_attempt_id,
    source_proposal_id, rollback_revision_id, now()
  )
  ON CONFLICT ("workspace_id", "goal_id", "result_objective_revision")
    WHERE "disposition" = 'applied'
    DO NOTHING;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION session_goal_reject_turn_snapshot_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."goal_snapshot" IS NOT NULL
    AND NEW."goal_snapshot" IS DISTINCT FROM OLD."goal_snapshot" THEN
    -- 1091: the secret scrub rewrites snapshot text inside its owner routine.
    IF current_setting('opengeni.session_secret_redaction', true) = 'v1' THEN
      IF current_user = (
        SELECT pg_catalog.pg_get_userbyid(relation.relowner)
        FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
      ) THEN
        IF opengeni_private.session_secret_redaction_writer_v1() THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
    RAISE EXCEPTION 'turn goal snapshot is immutable after acceptance'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION opengeni_private.guard_mcp_operation_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['original_outcome','original_result','original_result_codec_version',
      'observation_result','observation_result_codec_version','receipt_revision','receipt_digest','observed_at',
      'observation_claim_id','observation_claim_attempt_id','observation_claim_expires_at'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['original_outcome','original_result','original_result_codec_version',
      'observation_result','observation_result_codec_version','receipt_revision','receipt_digest','observed_at',
      'observation_claim_id','observation_claim_attempt_id','observation_claim_expires_at'])
  THEN RAISE EXCEPTION 'MCP operation identity and settled outcomes are immutable'; END IF;
  -- 1091: the secret scrub may rewrite the two result documents, and nothing
  -- else, inside its owner routine.
  IF current_setting('opengeni.session_secret_redaction', true) = 'v1'
    AND (to_jsonb(NEW) - ARRAY['original_result','observation_result'])
      IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['original_result','observation_result'])
  THEN
    IF current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
    ) THEN
      IF opengeni_private.session_secret_redaction_writer_v1() THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  IF (OLD.original_outcome<>'captured' AND
      (NEW.original_outcome,NEW.original_result,NEW.original_result_codec_version)
        IS DISTINCT FROM (OLD.original_outcome,OLD.original_result,OLD.original_result_codec_version))
    OR (OLD.receipt_digest IS NOT NULL AND
      (NEW.observation_result,NEW.observation_result_codec_version,NEW.receipt_revision,NEW.receipt_digest,NEW.observed_at,
        NEW.observation_claim_id,NEW.observation_claim_attempt_id,NEW.observation_claim_expires_at)
      IS DISTINCT FROM (OLD.observation_result,OLD.observation_result_codec_version,OLD.receipt_revision,OLD.receipt_digest,OLD.observed_at,
        OLD.observation_claim_id,OLD.observation_claim_attempt_id,OLD.observation_claim_expires_at))
  THEN RAISE EXCEPTION 'MCP operation identity and settled outcomes are immutable'; END IF;
  RETURN NEW;
END $$;

-- A scheduled occurrence's accepted content stays immutable (0275, 0717),
-- except that the secret scrub may rewrite its summary and payload, and nothing
-- else, inside its owner routine. Patched in place by exact anchor, as 0717
-- did, so every earlier clause and the stored search_path stay as they are.
DO $occurrence_scrub$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('fence_scheduled_occurrence_update()'::regprocedure);
  anchor := $old$    RETURN NEW;
  END IF;
  IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id
$old$;
  replacement := $new$    RETURN NEW;
  END IF;
  IF current_setting('opengeni.session_secret_redaction', true) = 'v1' THEN
    IF (to_jsonb(NEW) - ARRAY['summary', 'payload'])
        IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['summary', 'payload'])
    THEN
      IF opengeni_private.session_secret_redaction_writer_v1() THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  IF NEW.scheduled_task_run_id IS DISTINCT FROM OLD.scheduled_task_run_id
$new$;
  IF length(definition) - length(replace(definition, anchor, '')) <> length(anchor) THEN
    RAISE EXCEPTION 'fence_scheduled_occurrence_update anchor changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$occurrence_scrub$;

CREATE OR REPLACE FUNCTION refuse_imported_archive_execution()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  archive_id text;
  archive_state text;
BEGIN
  -- 1091: a secret scrub may rewrite the text an archived or imported session
  -- keeps: only the content columns of its turns, model history and goal,
  -- with every other column unchanged. It never inserts, and attempts and
  -- the wake outbox stay refused, so new execution stays refused.
  IF TG_OP = 'UPDATE'
    AND current_setting('opengeni.session_secret_redaction', true) = 'v1'
    AND (
      (TG_TABLE_NAME = 'session_turns'
        AND (to_jsonb(NEW) - ARRAY['prompt', 'model_context', 'metadata', 'goal_snapshot', 'updated_at'])
          IS NOT DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['prompt', 'model_context', 'metadata', 'goal_snapshot', 'updated_at']))
      OR (TG_TABLE_NAME = 'session_history_items'
        AND (to_jsonb(NEW) - ARRAY['item', 'item_ordered', 'updated_at'])
          IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['item', 'item_ordered', 'updated_at']))
      OR (TG_TABLE_NAME = 'session_goals'
        AND (to_jsonb(NEW) - ARRAY['text', 'success_criteria', 'evidence', 'rationale',
            'paused_reason', 'updated_at'])
          IS NOT DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['text', 'success_criteria', 'evidence', 'rationale',
            'paused_reason', 'updated_at']))
    )
  THEN
    RETURN NEW;
  END IF;
  SELECT imported_archive_import_id, content_archive_state INTO archive_id, archive_state
  FROM sessions
  WHERE workspace_id = NEW.workspace_id AND id = NEW.session_id FOR NO KEY UPDATE;
  IF archive_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  IF archive_state IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION guard_imported_archive_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Old fork/child writers must not turn historical input into executable
  -- content. This is a source guard, not just a guard on the destination marker.
  IF TG_OP = 'INSERT' OR
    (NEW.forked_from_session_id, NEW.parent_session_id) IS DISTINCT FROM
    (OLD.forked_from_session_id, OLD.parent_session_id) THEN
    IF EXISTS (SELECT 1 FROM sessions source WHERE source.account_id = NEW.account_id
      AND source.id IN (NEW.forked_from_session_id, NEW.parent_session_id)
      AND source.imported_archive_import_id IS NOT NULL FOR NO KEY UPDATE) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
    IF EXISTS (SELECT 1 FROM sessions source WHERE source.account_id = NEW.account_id
      AND source.id IN (NEW.forked_from_session_id, NEW.parent_session_id)
      AND source.content_archive_state IS NOT NULL FOR NO KEY UPDATE) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.imported_archive_import_id IS NOT NULL AND
    (NEW.imported_archive_import_id, NEW.imported_archive_imported_at,
      NEW.imported_archive_request_hash, NEW.imported_archive_subject_id)
    IS DISTINCT FROM
    (OLD.imported_archive_import_id, OLD.imported_archive_imported_at,
      OLD.imported_archive_request_hash, OLD.imported_archive_subject_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_archive_state = 'archived' AND
    (NEW.content_archive_state, NEW.content_archive_started_at, NEW.content_archived_at,
      NEW.content_archive, NEW.keep_live)
    IS DISTINCT FROM
    (OLD.content_archive_state, OLD.content_archive_started_at, OLD.content_archived_at,
      OLD.content_archive, OLD.keep_live) THEN
    -- 1091: the secret scrub swaps the manifest to rewritten objects inside
    -- its owner routine; the archive state itself never changes.
    IF NOT (
      current_setting('opengeni.session_secret_redaction', true) = 'v1'
      AND (NEW.content_archive_state, NEW.content_archive_started_at,
        NEW.content_archived_at, NEW.keep_live)
        IS NOT DISTINCT FROM
        (OLD.content_archive_state, OLD.content_archive_started_at,
          OLD.content_archived_at, OLD.keep_live)
      AND current_user = (
        SELECT pg_catalog.pg_get_userbyid(relation.relowner)
        FROM pg_catalog.pg_class relation WHERE relation.oid = TG_RELID
      )
      AND opengeni_private.session_secret_redaction_writer_v1()
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_ARCHIVED_READ_ONLY';
    END IF;
  END IF;
  IF NEW.imported_archive_import_id IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.imported_archive_import_id IS NULL) THEN
    IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_history_items WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_workflow_wake_outbox WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id)
      OR EXISTS (SELECT 1 FROM session_events WHERE workspace_id = NEW.workspace_id AND session_id = NEW.id) THEN
      RAISE EXCEPTION USING ERRCODE = 'OG002', MESSAGE = 'SESSION_IMPORTED_READ_ONLY';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION guard_task_note_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  -- 1091: the secret scrub's fixed capability (only its owner routines insert
  -- it) may rewrite a note's text and hash, and nothing else.
  IF current_setting('opengeni.session_secret_redaction', true) = 'v1'
    AND current_setting('opengeni.task_note_write_capability', true)
      = '5ec7e7ed-0988-4000-8000-5ec7e7ed0988'
  THEN
    IF (to_jsonb(NEW) - ARRAY['text', 'text_hash'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['text', 'text_hash'])
      OR NEW.text_hash <> encode(sha256(convert_to(NEW.text, 'UTF8')), 'hex')
    THEN
      RAISE EXCEPTION 'a secret scrub may change only task note text'
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
$function$;

DO $pin$
DECLARE data_schema text := current_schema();
BEGIN
  -- CREATE OR REPLACE drops SET clauses; restore the pins 0652 and 0239 gave.
  EXECUTE format(
    'ALTER FUNCTION guard_imported_archive_identity() SET search_path=pg_catalog,%I,pg_temp',
    data_schema);
  EXECUTE format(
    'ALTER FUNCTION refuse_imported_archive_execution() SET search_path=pg_catalog,%I,pg_temp',
    data_schema);
  EXECUTE format(
    'ALTER FUNCTION guard_task_note_mutation() SET search_path=pg_catalog,%I,pg_temp',
    data_schema);
END $pin$;

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.session_secret_redaction_rows_v1(
      p_workspace_id uuid, p_session_ids uuid[], p_table text, p_after uuid, p_limit integer
    ) RETURNS TABLE (row_key uuid, row_session_id uuid, cells jsonb)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE
      page_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
      sessions_value uuid[] := coalesce(p_session_ids, ARRAY[]::uuid[]);
      previous_capability text := current_setting('opengeni.task_note_write_capability', true);
    BEGIN
      IF p_workspace_id IS NULL
        OR nullif(current_setting('opengeni.workspace_id', true), '') IS DISTINCT FROM p_workspace_id::text
      THEN
        RAISE EXCEPTION 'secret redaction needs the caller''s workspace scope' USING ERRCODE = '42501';
      END IF;
      IF cardinality(sessions_value) > 1000 THEN
        RAISE EXCEPTION 'secret redaction reads at most 1000 sessions at once' USING ERRCODE = '22023';
      END IF;
      IF p_table = 'task_notes' THEN
        -- Reading notes needs a write capability (0239); the scrub's own.
        INSERT INTO %1$I.task_note_write_capabilities (backend_pid, transaction_id, capability_id)
        VALUES (pg_backend_pid(), pg_current_xact_id(), '5ec7e7ed-0988-4000-8000-5ec7e7ed0988')
        ON CONFLICT DO NOTHING;
        PERFORM set_config('opengeni.task_note_write_capability', '5ec7e7ed-0988-4000-8000-5ec7e7ed0988', true);
        RETURN QUERY
          SELECT note.id,
            CASE WHEN note.created_by_session_id = ANY(sessions_value)
              THEN note.created_by_session_id ELSE note.root_session_id END,
            jsonb_build_object('text', jsonb_build_object('value', note.text, 'codec', NULL))
          FROM %1$I.task_notes note
          WHERE note.workspace_id = p_workspace_id
            AND (note.root_session_id = ANY(sessions_value) OR note.created_by_session_id = ANY(sessions_value))
            AND (p_after IS NULL OR note.id > p_after)
          ORDER BY note.id
          LIMIT page_limit;
        DELETE FROM %1$I.task_note_write_capabilities capability
        WHERE capability.backend_pid = pg_backend_pid()
          AND capability.transaction_id = pg_current_xact_id()
          AND capability.capability_id = '5ec7e7ed-0988-4000-8000-5ec7e7ed0988';
        PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
      ELSIF p_table = 'host_export_outbox' THEN
        RETURN QUERY
          SELECT outbox.id, outbox.session_id,
            jsonb_build_object('payload', jsonb_build_object(
              'value', outbox.payload::text, 'codec', outbox.payload_codec_version))
          FROM %1$I.host_export_outbox outbox
          WHERE outbox.workspace_id = p_workspace_id
            AND outbox.session_id = ANY(sessions_value)
            AND (p_after IS NULL OR outbox.id > p_after)
          ORDER BY outbox.id
          LIMIT page_limit;
      ELSIF p_table = 'mcp_operations' THEN
        RETURN QUERY
          SELECT operation.operation_id, operation.session_id,
            jsonb_strip_nulls(jsonb_build_object(
              'original_result', CASE WHEN operation.original_result IS NULL THEN NULL
                ELSE jsonb_build_object('value', operation.original_result::text,
                  'codec', operation.original_result_codec_version) END,
              'observation_result', CASE WHEN operation.observation_result IS NULL THEN NULL
                ELSE jsonb_build_object('value', operation.observation_result::text,
                  'codec', operation.observation_result_codec_version) END))
          FROM %1$I.mcp_operations operation
          WHERE operation.workspace_id = p_workspace_id
            AND operation.session_id = ANY(sessions_value)
            AND (p_after IS NULL OR operation.operation_id > p_after)
          ORDER BY operation.operation_id
          LIMIT page_limit;
      ELSIF p_table = 'session_history_items_repair_audit' THEN
        RETURN QUERY
          SELECT audit.id, audit.session_id,
            jsonb_build_object('item', jsonb_build_object('value', audit.item::text, 'codec', NULL))
          FROM %1$I.session_history_items_repair_audit audit
          WHERE audit.workspace_id = p_workspace_id
            AND audit.session_id = ANY(sessions_value)
            AND (p_after IS NULL OR audit.id > p_after)
          ORDER BY audit.id
          LIMIT page_limit;
      ELSE
        RAISE EXCEPTION 'secret redaction cannot read this table' USING ERRCODE = '22023';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
      RAISE;
    END $body$;
  $create$, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.session_secret_redaction_rows_v1(uuid, uuid[], text, uuid, integer) FROM PUBLIC;

  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.redact_session_secret_cells_v1(
      p_workspace_id uuid, p_table text, p_cells jsonb
    ) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE
      data_schema constant text := %2$L;
      cell jsonb;
      column_name text;
      key_column text := 'id';
      text_columns text[] := ARRAY[]::text[];
      json_columns text[] := ARRAY[]::text[];
      changed integer := 0;
      affected integer;
      previous_marker text := current_setting('opengeni.session_secret_redaction', true);
      previous_capability text := current_setting('opengeni.task_note_write_capability', true);
      previous_pattern text := current_setting('opengeni.session_message_search_pattern', true);
      old_manifest jsonb;
      new_manifest jsonb;
      session_value uuid;
      session_column text := 'session_id';
      key_prefix text;
      unchanged_manifest_keys constant text[] := ARRAY['bundle', 'transcript', 'objectKeys', 'sha256'];
      unchanged_object_keys constant text[] := ARRAY['key', 'bytes', 'sha256'];
    BEGIN
      IF p_workspace_id IS NULL
        OR nullif(current_setting('opengeni.workspace_id', true), '') IS DISTINCT FROM p_workspace_id::text
      THEN
        RAISE EXCEPTION 'secret redaction needs the caller''s workspace scope' USING ERRCODE = '42501';
      END IF;
      -- Like every session writer, hold the workspace's shared tenancy fence
      -- before any row lock or write.
      PERFORM %1$I.acquire_session_tenancy_fence(p_workspace_id);
      IF jsonb_typeof(p_cells) IS DISTINCT FROM 'array' OR jsonb_array_length(p_cells) > 500 THEN
        RAISE EXCEPTION 'secret redaction takes an array of at most 500 cells' USING ERRCODE = '22023';
      END IF;
      CASE p_table
        WHEN 'session_goals' THEN
          text_columns := ARRAY['text', 'success_criteria', 'evidence', 'rationale', 'paused_reason'];
        WHEN 'session_goal_revisions' THEN
          text_columns := ARRAY['text', 'success_criteria', 'rationale'];
        WHEN 'session_turns' THEN
          json_columns := ARRAY['goal_snapshot'];
        WHEN 'task_notes' THEN
          text_columns := ARRAY['text'];
        WHEN 'host_export_outbox' THEN
          json_columns := ARRAY['payload'];
        WHEN 'mcp_operations' THEN
          key_column := 'operation_id';
          json_columns := ARRAY['original_result', 'observation_result'];
        WHEN 'session_history_items_repair_audit' THEN
          json_columns := ARRAY['item'];
        WHEN 'session_system_updates' THEN
          text_columns := ARRAY['summary'];
          json_columns := ARRAY['payload'];
        WHEN 'session_message_search_texts', 'session_content_blobs', 'sessions' THEN
          NULL;
        ELSE
          RAISE EXCEPTION 'secret redaction cannot write this table' USING ERRCODE = '22023';
      END CASE;

      -- The marker and this transaction's capability row together let the
      -- guards' narrow exceptions apply (session_secret_redaction_writer_v1).
      PERFORM set_config('opengeni.session_secret_redaction', 'v1', true);
      INSERT INTO %1$I.task_note_write_capabilities (backend_pid, transaction_id, capability_id)
      VALUES (pg_backend_pid(), pg_current_xact_id(), '5ec7e7ed-0988-4000-8000-5ec7e7ed0988')
      ON CONFLICT DO NOTHING;
      IF p_table = 'task_notes' THEN
        PERFORM set_config('opengeni.task_note_write_capability', '5ec7e7ed-0988-4000-8000-5ec7e7ed0988', true);
      ELSIF p_table = 'session_message_search_texts' THEN
        PERFORM set_config('opengeni.session_message_search_pattern', '^', true);
      END IF;

      FOR cell IN SELECT value FROM jsonb_array_elements(p_cells) LOOP
        IF jsonb_typeof(cell) IS DISTINCT FROM 'object' OR cell->>'key' IS NULL
          OR (p_table NOT IN ('session_message_search_texts', 'sessions') AND cell->>'session' IS NULL)
        THEN
          RAISE EXCEPTION 'secret redaction cell is invalid' USING ERRCODE = '22023';
        END IF;
        IF p_table = 'session_message_search_texts' THEN
          -- Resync every search row of one session to its event's current text.
          UPDATE %1$I.session_message_search_texts search_row
          SET text = event.payload->>'text',
            encoded = starts_with(event.payload->>'text', 'opengeni_lossless_json_string_v2_81f06e15:')
          FROM %1$I.session_events event
          WHERE search_row.workspace_id = p_workspace_id
            AND search_row.session_id = (cell->>'key')::uuid
            AND event.workspace_id = search_row.workspace_id
            AND event.session_id = search_row.session_id
            AND event.sequence = search_row.sequence
            AND jsonb_typeof(event.payload->'text') = 'string'
            AND search_row.text IS DISTINCT FROM event.payload->>'text';
        ELSIF p_table = 'session_content_blobs' THEN
          -- Delete a blob only while it still holds what was read and nothing
          -- refers to it any more.
          DELETE FROM %1$I.session_content_blobs blob
          WHERE blob.workspace_id = p_workspace_id
            AND blob.session_id = (cell->>'session')::uuid
            AND blob.digest = cell->>'key'
            AND md5(blob.value::text) = cell->>'before'
            AND NOT EXISTS (
              SELECT 1 FROM %1$I.session_attempt_model_context_snapshots snapshot_row
              WHERE snapshot_row.workspace_id = blob.workspace_id
                AND snapshot_row.session_id = blob.session_id
                AND strpos(snapshot_row.content_refs::text, '"' || blob.digest || '"') > 0)
            AND NOT EXISTS (
              SELECT 1 FROM %1$I.session_attempt_tool_catalogs catalog_row
              WHERE catalog_row.workspace_id = blob.workspace_id
                AND catalog_row.session_id = blob.session_id
                AND strpos(catalog_row.content_refs::text, '"' || blob.digest || '"') > 0);
        ELSIF p_table = 'sessions' THEN
          -- Swap an archived session's manifest to rewritten objects under the
          -- session's own archive prefix, and queue the replaced objects.
          session_value := (cell->>'key')::uuid;
          new_manifest := (cell->>'value')::jsonb;
          key_prefix := 'session-archives/' || p_workspace_id::text || '/' || session_value::text || '/';
          IF jsonb_typeof(new_manifest) IS DISTINCT FROM 'object'
            OR jsonb_typeof(new_manifest->'bundle') IS DISTINCT FROM 'object'
            OR jsonb_typeof(new_manifest->'transcript') IS DISTINCT FROM 'object'
            OR jsonb_typeof(new_manifest->'bundle'->'key') IS DISTINCT FROM 'string'
            OR jsonb_typeof(new_manifest->'transcript'->'key') IS DISTINCT FROM 'string'
            OR new_manifest->'objectKeys' IS DISTINCT FROM
              jsonb_build_array(new_manifest->'bundle'->'key', new_manifest->'transcript'->'key')
            OR NOT starts_with(new_manifest->'bundle'->>'key', key_prefix)
            OR NOT starts_with(new_manifest->'transcript'->>'key', key_prefix)
          THEN
            RAISE EXCEPTION 'secret redaction manifest is invalid' USING ERRCODE = '22023';
          END IF;
          SELECT session_row.content_archive INTO old_manifest
          FROM %1$I.sessions session_row
          WHERE session_row.workspace_id = p_workspace_id AND session_row.id = session_value
            AND session_row.content_archive_state = 'archived'
            AND md5(session_row.content_archive::text) = cell->>'before'
          FOR NO KEY UPDATE;
          -- Only the two objects' key, size and digest (and the top-level
          -- digest, which follows the bundle's, and the bundle's content-blob
          -- row count, which changes when a rewritten model request is
          -- re-chunked) may change; a changed object must move to a key the
          -- old manifest never used.
          IF FOUND AND (
            ((new_manifest - unchanged_manifest_keys)
              || jsonb_build_object('rowCounts', (new_manifest->'rowCounts') - 'session_content_blobs'))
              IS DISTINCT FROM ((old_manifest - unchanged_manifest_keys)
              || jsonb_build_object('rowCounts', (old_manifest->'rowCounts') - 'session_content_blobs'))
            OR (new_manifest->'rowCounts' ? 'session_content_blobs'
              AND jsonb_typeof(new_manifest->'rowCounts'->'session_content_blobs') IS DISTINCT FROM 'number')
            OR ((new_manifest->'bundle') - unchanged_object_keys)
              IS DISTINCT FROM ((old_manifest->'bundle') - unchanged_object_keys)
            OR ((new_manifest->'transcript') - unchanged_object_keys)
              IS DISTINCT FROM ((old_manifest->'transcript') - unchanged_object_keys)
            OR (old_manifest->'sha256' IS NOT DISTINCT FROM old_manifest->'bundle'->'sha256'
              AND new_manifest->'sha256' IS DISTINCT FROM new_manifest->'bundle'->'sha256')
            OR (old_manifest->'sha256' IS DISTINCT FROM old_manifest->'bundle'->'sha256'
              AND new_manifest->'sha256' IS DISTINCT FROM old_manifest->'sha256')
            OR (new_manifest->'bundle' IS DISTINCT FROM old_manifest->'bundle'
              AND coalesce(old_manifest->'objectKeys', '[]'::jsonb) ? (new_manifest->'bundle'->>'key'))
            OR (new_manifest->'transcript' IS DISTINCT FROM old_manifest->'transcript'
              AND coalesce(old_manifest->'objectKeys', '[]'::jsonb) ? (new_manifest->'transcript'->>'key'))
          ) THEN
            RAISE EXCEPTION 'secret redaction manifest is invalid' USING ERRCODE = '22023';
          END IF;
          IF FOUND THEN
            INSERT INTO opengeni_private.session_archive_object_deletions
              (object_key, account_id, workspace_id, session_id)
            SELECT old_key, session_row.account_id, session_row.workspace_id, session_row.id
            FROM %1$I.sessions session_row,
              jsonb_array_elements_text(coalesce(old_manifest->'objectKeys', '[]'::jsonb)) old_key
            WHERE session_row.workspace_id = p_workspace_id AND session_row.id = session_value
              AND NOT (new_manifest->'objectKeys' ? old_key)
            ON CONFLICT (object_key) DO NOTHING;
            -- Last, so the row count below is this update's.
            UPDATE %1$I.sessions session_row SET content_archive = new_manifest
            WHERE session_row.workspace_id = p_workspace_id AND session_row.id = session_value;
          END IF;
        ELSE
          -- Each cell names its session and must belong to it, and the new
          -- value may only replace spans of the old one with markers
          -- (session_secret_redaction_shape_v1).
          column_name := cell->>'column';
          IF column_name = ANY(text_columns) THEN
            EXECUTE format(
              'UPDATE %%I.%%I target SET %%I = $1%%s WHERE target.workspace_id = $2 AND target.%%I = $3::uuid AND md5(target.%%I::text) = $4 AND %%s AND opengeni_private.session_secret_redaction_shape_v1(target.%%I::text, $1)',
              data_schema, p_table, column_name,
              CASE WHEN p_table = 'task_notes'
                THEN ', text_hash = encode(sha256(convert_to($1, ''UTF8'')), ''hex'')' ELSE '' END,
              key_column, column_name,
              CASE WHEN p_table = 'task_notes'
                THEN '$5::uuid IN (target.root_session_id, target.created_by_session_id)'
                ELSE format('target.%%I = $5::uuid', session_column) END,
              column_name)
            USING cell->>'value', p_workspace_id, cell->>'key', cell->>'before', cell->>'session';
          ELSIF column_name = ANY(json_columns) THEN
            EXECUTE format(
              'UPDATE %%I.%%I target SET %%I = $1::jsonb WHERE target.workspace_id = $2 AND target.%%I = $3::uuid AND md5(target.%%I::text) = $4 AND target.%%I = $5::uuid AND opengeni_private.session_secret_redaction_shape_v1(target.%%I::text, $1::jsonb::text)',
              data_schema, p_table, column_name, key_column, column_name, session_column, column_name)
            USING cell->>'value', p_workspace_id, cell->>'key', cell->>'before', cell->>'session';
          ELSE
            RAISE EXCEPTION 'secret redaction cannot write this column' USING ERRCODE = '22023';
          END IF;
        END IF;
        GET DIAGNOSTICS affected = ROW_COUNT;
        changed := changed + affected;
      END LOOP;

      DELETE FROM %1$I.task_note_write_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id()
        AND capability.capability_id = '5ec7e7ed-0988-4000-8000-5ec7e7ed0988';
      PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
      PERFORM set_config('opengeni.session_message_search_pattern', coalesce(previous_pattern, ''), true);
      PERFORM set_config('opengeni.session_secret_redaction', coalesce(previous_marker, ''), true);
      RETURN changed;
    EXCEPTION WHEN OTHERS THEN
      PERFORM set_config('opengeni.task_note_write_capability', coalesce(previous_capability, ''), true);
      PERFORM set_config('opengeni.session_message_search_pattern', coalesce(previous_pattern, ''), true);
      PERFORM set_config('opengeni.session_secret_redaction', coalesce(previous_marker, ''), true);
      RAISE;
    END $body$;
  $create$, data_schema, data_schema);
  REVOKE ALL ON FUNCTION opengeni_private.redact_session_secret_cells_v1(uuid, text, jsonb) FROM PUBLIC;
END $install$;
