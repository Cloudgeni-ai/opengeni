-- deployment-mode: rolling
-- Freeze the content-free legacy workspace-Memory candidate selection once per
-- accepted logical turn. Recovery reuses that selection and may only lose rows
-- that fail current lifecycle/hash authorization.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION opengeni_private.company_brain_memory_selections_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  item jsonb;
  item_id text;
  seen_ids text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(value) <> 'array'
    OR jsonb_array_length(value) > 50
    OR octet_length(value::text) > 16384
  THEN
    RETURN false;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS entries(element)
  LOOP
    IF jsonb_typeof(item) <> 'object'
      OR (SELECT count(*) FROM pg_catalog.jsonb_object_keys(item)) <> 7
      OR NOT (item ?& ARRAY['id','kind','textHash','contentHash','textCodecVersion','memoryVersion','pinned'])
      OR jsonb_typeof(item->'id') <> 'string'
      OR jsonb_typeof(item->'kind') <> 'string'
      OR jsonb_typeof(item->'textHash') <> 'string'
      OR jsonb_typeof(item->'contentHash') <> 'string'
      OR jsonb_typeof(item->'textCodecVersion') NOT IN ('number','null')
      OR jsonb_typeof(item->'memoryVersion') <> 'number'
      OR jsonb_typeof(item->'pinned') <> 'boolean'
      OR item->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR item->>'kind' NOT IN ('semantic','procedural','decision','preference')
      OR item->>'textHash' !~ '^[0-9a-f]{64}$'
      OR item->>'contentHash' !~ '^[0-9a-f]{64}$'
      OR (jsonb_typeof(item->'textCodecVersion') = 'number' AND (
        item->>'textCodecVersion' !~ '^(0|[1-9][0-9]{0,9})$'
        OR (item->>'textCodecVersion')::numeric > 2147483647
      ))
      OR item->>'memoryVersion' !~ '^[1-9][0-9]{0,9}$'
      OR (item->>'memoryVersion')::numeric > 2147483647
    THEN
      RETURN false;
    END IF;
    item_id := item->>'id';
    IF item_id = ANY(seen_ids) THEN
      RETURN false;
    END IF;
    seen_ids := array_append(seen_ids, item_id);
  END LOOP;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.company_brain_memory_selections_valid(jsonb) FROM PUBLIC;

CREATE TABLE "company_brain_context_selection_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "root_session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "created_by_attempt_id" uuid NOT NULL,
  "created_by_execution_generation" integer NOT NULL,
  "accepted_at" timestamptz NOT NULL,
  "session_role" text NOT NULL,
  "memory_enabled" boolean NOT NULL,
  "memory_prompt_mode" text NOT NULL,
  "company_profile_included" boolean NOT NULL,
  "instruction_policy_entry_hash" text NOT NULL,
  "preference_descriptor_hash" text,
  "company_profile_snapshot_hash" text NOT NULL,
  "memory_selections" jsonb NOT NULL,
  "selection_hash" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "company_brain_context_selection_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces" ("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "company_brain_context_selection_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "company_brain_context_selection_root_session_fk"
    FOREIGN KEY ("workspace_id", "root_session_id")
    REFERENCES "sessions" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "company_brain_context_selection_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "company_brain_context_selection_attempt_fk"
    FOREIGN KEY ("workspace_id", "created_by_attempt_id")
    REFERENCES "session_turn_attempts" ("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "company_brain_context_selection_generation_check"
    CHECK ("created_by_execution_generation" > 0),
  CONSTRAINT "company_brain_context_selection_role_check"
    CHECK ("session_role" IN ('root','child')),
  CONSTRAINT "company_brain_context_selection_mode_check"
    CHECK ("memory_prompt_mode" IN ('legacy_standing','retrieval_only')),
  CONSTRAINT "company_brain_context_selection_profile_inclusion_check"
    CHECK ("company_profile_included" = ("memory_prompt_mode" = 'legacy_standing' OR "session_role" = 'root')),
  CONSTRAINT "company_brain_context_selection_hashes_check"
    CHECK (
      "instruction_policy_entry_hash" ~ '^[0-9a-f]{64}$'
      AND ("preference_descriptor_hash" IS NULL OR "preference_descriptor_hash" ~ '^[0-9a-f]{64}$')
      AND "company_profile_snapshot_hash" ~ '^[0-9a-f]{64}$'
      AND "selection_hash" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "company_brain_context_selection_memory_check"
    CHECK (
      opengeni_private.company_brain_memory_selections_valid("memory_selections")
      AND (("memory_enabled" AND "memory_prompt_mode" = 'legacy_standing')
        OR jsonb_array_length("memory_selections") = 0)
    )
);

CREATE UNIQUE INDEX "company_brain_context_selection_turn_uq"
  ON "company_brain_context_selection_receipts" ("workspace_id", "turn_id");
CREATE INDEX "company_brain_context_selection_workspace_time_idx"
  ON "company_brain_context_selection_receipts" ("workspace_id", "created_at", "id");

ALTER TABLE "company_brain_context_selection_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_brain_context_selection_receipts" FORCE ROW LEVEL SECURITY;

CREATE POLICY company_brain_context_selection_tenant
  ON "company_brain_context_selection_receipts"
  USING (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  )
  WITH CHECK (
    "account_id" = opengeni_private.current_account_id()
    AND "workspace_id" = opengeni_private.current_workspace_id()
  );
CREATE POLICY session_visibility_isolation
  ON "company_brain_context_selection_receipts" AS RESTRICTIVE
  USING (session_reference_visible("account_id", "workspace_id", "root_session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "root_session_id"));

CREATE OR REPLACE FUNCTION guard_company_brain_context_selection_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND id = OLD.session_id)
      OR NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = OLD.workspace_id AND id = OLD.root_session_id)
      OR NOT EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = OLD.workspace_id AND id = OLD.turn_id)
      OR NOT EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = OLD.workspace_id AND id = OLD.created_by_attempt_id)
    )
  THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Company Brain context selection receipts are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER company_brain_context_selection_receipts_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON "company_brain_context_selection_receipts"
  FOR EACH ROW EXECUTE FUNCTION guard_company_brain_context_selection_receipt();

CREATE OR REPLACE FUNCTION company_brain_context_get_or_create_selection(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_turn_id uuid,
  p_attempt_id uuid,
  p_execution_generation integer
) RETURNS TABLE (
  receipt_id uuid,
  root_session_id uuid,
  accepted_at timestamptz,
  session_role text,
  memory_enabled boolean,
  memory_prompt_mode text,
  company_profile_included boolean,
  instruction_policy_entry_hash text,
  preference_descriptor_hash text,
  company_profile_snapshot_hash text,
  selection_hash text,
  selected_memory_count integer,
  visible_memory_count integer,
  memory_id uuid,
  memory_kind text,
  memory_text text,
  memory_text_codec_version integer,
  memory_pinned boolean,
  selection_ordinal integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  authority record;
  turn_accepted_at timestamptz;
  nested_depth integer;
  workspace_settings jsonb;
  policy_hash text;
  preference_hash text;
  profile_hash text;
  candidate_selections jsonb;
  calculated_selection_hash text;
  receipt_row company_brain_context_selection_receipts%ROWTYPE;
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
    RAISE EXCEPTION 'Company Brain context selection requires exact tenant authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT authority FROM resolve_task_note_attempt_authority(
    p_account_id, p_workspace_id, p_session_id, p_turn_id,
    p_attempt_id, p_execution_generation
  );

  SELECT turn.created_at, session.nested_agent_depth, workspace.settings
  INTO STRICT turn_accepted_at, nested_depth, workspace_settings
  FROM workspaces workspace
  JOIN sessions session
    ON session.account_id = workspace.account_id AND session.workspace_id = workspace.id
  JOIN session_turns turn
    ON turn.account_id = session.account_id
    AND turn.workspace_id = session.workspace_id
    AND turn.session_id = session.id
  WHERE workspace.account_id = p_account_id
    AND workspace.id = p_workspace_id
    AND session.id = p_session_id
    AND turn.id = p_turn_id;

  SELECT snapshot.entry_hash INTO STRICT policy_hash
  FROM workspace_instruction_policy_snapshots snapshot
  WHERE snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.attempt_id = p_attempt_id
    AND snapshot.execution_generation = p_execution_generation;
  SELECT snapshot.snapshot_hash INTO STRICT profile_hash
  FROM company_profile_snapshots snapshot
  WHERE snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.attempt_id = p_attempt_id
    AND snapshot.execution_generation = p_execution_generation;
  SELECT snapshot.descriptor_hash INTO preference_hash
  FROM preference_registry_snapshots snapshot
  WHERE snapshot.account_id = p_account_id
    AND snapshot.workspace_id = p_workspace_id
    AND snapshot.session_id = p_session_id
    AND snapshot.turn_id = p_turn_id
    AND snapshot.attempt_id = p_attempt_id
    AND snapshot.execution_generation = p_execution_generation;

  PERFORM pg_catalog.set_config(
    'opengeni.subject_id',
    CASE WHEN authority.actor_kind = 'human' THEN authority.actor_subject_id ELSE '' END,
    true
  );
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(authority.initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := true;

  SELECT * INTO receipt_row
  FROM company_brain_context_selection_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.session_id = p_session_id
    AND receipt.turn_id = p_turn_id
  FOR SHARE;

  IF FOUND THEN
    IF receipt_row.root_session_id IS DISTINCT FROM authority.root_session_id
      OR receipt_row.accepted_at IS DISTINCT FROM turn_accepted_at
      OR receipt_row.session_role IS DISTINCT FROM
        (CASE WHEN nested_depth = 0 THEN 'root' ELSE 'child' END)
      OR receipt_row.instruction_policy_entry_hash IS DISTINCT FROM policy_hash
      OR receipt_row.preference_descriptor_hash IS DISTINCT FROM preference_hash
      OR receipt_row.company_profile_snapshot_hash IS DISTINCT FROM profile_hash
    THEN
      RAISE EXCEPTION 'Company Brain context recovery conflicts with accepted selection authority'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    memory_enabled := CASE
      WHEN jsonb_typeof(workspace_settings->'memoryEnabled') = 'boolean'
        THEN (workspace_settings->>'memoryEnabled')::boolean
      ELSE false
    END;
    memory_prompt_mode := CASE workspace_settings->>'memoryPromptMode'
      WHEN 'retrieval_only' THEN 'retrieval_only'
      ELSE 'legacy_standing'
    END;
    session_role := CASE WHEN nested_depth = 0 THEN 'root' ELSE 'child' END;
    company_profile_included := memory_prompt_mode = 'legacy_standing' OR session_role = 'root';

    IF memory_enabled AND memory_prompt_mode = 'legacy_standing' THEN
      SELECT COALESCE(jsonb_agg(candidate.reference ORDER BY candidate.ordinal), '[]'::jsonb)
      INTO candidate_selections
      FROM (
        SELECT jsonb_build_object(
          'id', memory.id,
          'kind', memory.kind,
          'textHash', memory.text_hash,
          'contentHash', encode(sha256(convert_to(memory.text, 'UTF8')), 'hex'),
          'textCodecVersion', memory.text_codec_version,
          'memoryVersion', memory.memory_version,
          'pinned', memory.pinned
        ) AS reference,
        row_number() OVER (
          ORDER BY memory.pinned DESC, memory.updated_at DESC, memory.id DESC
        ) AS ordinal
        FROM knowledge_memories memory
        WHERE memory.account_id = p_account_id
          AND memory.workspace_id = p_workspace_id
          AND memory.scope_type = 'workspace'
          AND memory.scope_subject_id IS NULL
          AND memory.scope_role_key IS NULL
          AND memory.scope_session_id IS NULL
          AND memory.status IN ('active','approved')
          AND memory.kind IN ('semantic','procedural','decision','preference')
          AND memory.text_hash ~ '^[0-9a-f]{64}$'
          AND memory.memory_version > 0
          AND memory.created_at <= turn_accepted_at
          AND memory.updated_at <= turn_accepted_at
          AND memory.valid_from <= turn_accepted_at
          AND (memory.valid_until IS NULL OR memory.valid_until > turn_accepted_at)
        ORDER BY memory.pinned DESC, memory.updated_at DESC, memory.id DESC
        LIMIT 50
      ) candidate;
    ELSE
      candidate_selections := '[]'::jsonb;
    END IF;

    calculated_selection_hash := encode(sha256(convert_to(jsonb_build_object(
      'accountId', p_account_id,
      'workspaceId', p_workspace_id,
      'sessionId', p_session_id,
      'rootSessionId', authority.root_session_id,
      'turnId', p_turn_id,
      'acceptedAt', turn_accepted_at,
      'sessionRole', session_role,
      'memoryEnabled', memory_enabled,
      'memoryPromptMode', memory_prompt_mode,
      'companyProfileIncluded', company_profile_included,
      'instructionPolicyEntryHash', policy_hash,
      'preferenceDescriptorHash', preference_hash,
      'companyProfileSnapshotHash', profile_hash,
      'memorySelections', candidate_selections
    )::text, 'UTF8')), 'hex');

    INSERT INTO company_brain_context_selection_receipts (
      account_id, workspace_id, session_id, root_session_id, turn_id,
      created_by_attempt_id, created_by_execution_generation, accepted_at,
      session_role, memory_enabled, memory_prompt_mode, company_profile_included,
      instruction_policy_entry_hash, preference_descriptor_hash,
      company_profile_snapshot_hash, memory_selections, selection_hash
    ) VALUES (
      p_account_id, p_workspace_id, p_session_id, authority.root_session_id, p_turn_id,
      p_attempt_id, p_execution_generation, turn_accepted_at,
      session_role, memory_enabled, memory_prompt_mode, company_profile_included,
      policy_hash, preference_hash, profile_hash, candidate_selections,
      calculated_selection_hash
    )
    ON CONFLICT (workspace_id, turn_id) DO NOTHING
    RETURNING * INTO receipt_row;

    IF receipt_row.id IS NULL THEN
      SELECT * INTO STRICT receipt_row
      FROM company_brain_context_selection_receipts receipt
      WHERE receipt.account_id = p_account_id
        AND receipt.workspace_id = p_workspace_id
        AND receipt.session_id = p_session_id
        AND receipt.turn_id = p_turn_id
      FOR SHARE;
      IF receipt_row.selection_hash IS DISTINCT FROM calculated_selection_hash THEN
        RAISE EXCEPTION 'Company Brain context selection winner is not canonical'
          USING ERRCODE = '40001';
      END IF;
    END IF;
  END IF;

  RETURN QUERY
  WITH selected AS (
    SELECT entry.value AS reference, entry.ordinality::integer AS ordinal
    FROM jsonb_array_elements(receipt_row.memory_selections) WITH ORDINALITY entry(value, ordinality)
  ), visible AS (
    SELECT selected.ordinal, memory.id, memory.kind, memory.text,
      memory.text_codec_version, memory.pinned
    FROM selected
    JOIN knowledge_memories memory
      ON memory.account_id = receipt_row.account_id
      AND memory.workspace_id = receipt_row.workspace_id
      AND memory.id = (selected.reference->>'id')::uuid
      AND memory.kind = selected.reference->>'kind'
      AND memory.text_hash = selected.reference->>'textHash'
      AND encode(sha256(convert_to(memory.text, 'UTF8')), 'hex') = selected.reference->>'contentHash'
      AND memory.text_codec_version IS NOT DISTINCT FROM
        CASE WHEN jsonb_typeof(selected.reference->'textCodecVersion') = 'null'
          THEN NULL ELSE (selected.reference->>'textCodecVersion')::integer END
      AND memory.memory_version = (selected.reference->>'memoryVersion')::integer
      AND memory.pinned = (selected.reference->>'pinned')::boolean
    WHERE memory.scope_type = 'workspace'
      AND memory.scope_subject_id IS NULL
      AND memory.scope_role_key IS NULL
      AND memory.scope_session_id IS NULL
      AND memory.status IN ('active','approved')
      AND memory.kind IN ('semantic','procedural','decision','preference')
      AND memory.valid_from <= transaction_timestamp()
      AND (memory.valid_until IS NULL OR memory.valid_until > transaction_timestamp())
  ), counts AS (
    SELECT jsonb_array_length(receipt_row.memory_selections)::integer AS selected_count,
      (SELECT count(*)::integer FROM visible) AS visible_count
  )
  SELECT receipt_row.id, receipt_row.root_session_id, receipt_row.accepted_at,
    receipt_row.session_role, receipt_row.memory_enabled, receipt_row.memory_prompt_mode,
    receipt_row.company_profile_included, receipt_row.instruction_policy_entry_hash,
    receipt_row.preference_descriptor_hash, receipt_row.company_profile_snapshot_hash,
    receipt_row.selection_hash, counts.selected_count, counts.visible_count,
    visible.id, visible.kind, visible.text, visible.text_codec_version,
    visible.pinned, visible.ordinal
  FROM counts
  LEFT JOIN visible ON true
  ORDER BY visible.ordinal NULLS LAST;

  PERFORM pg_catalog.set_config('opengeni.subject_id', COALESCE(previous_subject_id, ''), true);
  PERFORM pg_catalog.set_config(
    'opengeni.initiating_human_subject_id',
    COALESCE(previous_initiating_human_subject_id, ''),
    true
  );
  visibility_context_set := false;
EXCEPTION WHEN OTHERS THEN
  IF visibility_context_set THEN
    PERFORM pg_catalog.set_config('opengeni.subject_id', COALESCE(previous_subject_id, ''), true);
    PERFORM pg_catalog.set_config(
      'opengeni.initiating_human_subject_id',
      COALESCE(previous_initiating_human_subject_id, ''),
      true
    );
  END IF;
  RAISE;
END;
$$;

DO $company_brain_context_search_paths$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %1$I.guard_company_brain_context_selection_receipt() SET search_path = %1$I, pg_catalog',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %1$I.company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer) SET search_path = %1$I, pg_catalog',
    data_schema
  );
END
$company_brain_context_search_paths$;

REVOKE ALL ON TABLE "company_brain_context_selection_receipts" FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_company_brain_context_selection_receipt() FROM PUBLIC;
REVOKE ALL ON FUNCTION company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer) FROM PUBLIC;

DO $company_brain_context_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE "company_brain_context_selection_receipts" FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION company_brain_context_get_or_create_selection(uuid,uuid,uuid,uuid,uuid,integer)
      TO opengeni_app;
  END IF;
END
$company_brain_context_runtime_grants$;
