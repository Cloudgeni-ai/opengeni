-- deployment-mode: rolling
-- Migration 0266: human-authorized, content-free Company Brain receipt inspection.
-- The existing 0259 receipt remains immutable and runtime-inaccessible. This
-- read-only capability projects bounded facts for already-materialized logical
-- turns; it never creates or repairs a receipt and never returns selected
-- memory identities or content.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION company_brain_inspect_context_receipts(
  p_account_id uuid,
  p_workspace_id uuid,
  p_subject_id text,
  p_attempt_id uuid DEFAULT NULL,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
) RETURNS TABLE (
  receipt_id uuid,
  session_id uuid,
  root_session_id uuid,
  turn_id uuid,
  accepted_at timestamptz,
  created_at timestamptz,
  session_role text,
  memory_enabled boolean,
  memory_prompt_mode text,
  company_profile_included boolean,
  instruction_policy_entry_hash text,
  preference_descriptor_hash text,
  company_profile_snapshot_hash text,
  turn_context_snapshot_id uuid,
  turn_context_snapshot_hash text,
  turn_context_snapshot_source text,
  selection_hash text,
  selected_memory_count integer,
  rendered_memory_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_account_id IS NULL
    OR p_workspace_id IS NULL
    OR p_subject_id IS NULL
    OR p_subject_id = ''
    OR pg_catalog.octet_length(pg_catalog.convert_to(p_subject_id, 'UTF8')) > 1024
    OR p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN
    RAISE EXCEPTION 'Company Brain receipt inspection requires exact human tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 51
    OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
    OR (p_attempt_id IS NOT NULL AND p_before_created_at IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Company Brain receipt inspection has invalid bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT
    receipt.id,
    receipt.session_id,
    receipt.root_session_id,
    receipt.turn_id,
    receipt.accepted_at,
    receipt.created_at,
    receipt.session_role,
    receipt.memory_enabled,
    receipt.memory_prompt_mode,
    receipt.company_profile_included,
    receipt.instruction_policy_entry_hash,
    receipt.preference_descriptor_hash,
    receipt.company_profile_snapshot_hash,
    receipt.turn_context_snapshot_id,
    receipt.turn_context_snapshot_hash,
    receipt.turn_context_snapshot_source,
    receipt.selection_hash,
    pg_catalog.jsonb_array_length(receipt.memory_selections),
    pg_catalog.jsonb_array_length(receipt.rendered_memory_selections)
  FROM company_brain_context_selection_receipts receipt
  JOIN session_turns turn_row
    ON turn_row.account_id = receipt.account_id
    AND turn_row.workspace_id = receipt.workspace_id
    AND turn_row.session_id = receipt.session_id
    AND turn_row.id = receipt.turn_id
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND turn_row.initiating_human_subject_id = p_subject_id
    AND session_reference_visible(
      receipt.account_id, receipt.workspace_id, receipt.session_id
    )
    AND session_reference_visible(
      receipt.account_id, receipt.workspace_id, receipt.root_session_id
    )
    AND (
      p_attempt_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM session_turn_attempts attempt_row
        WHERE attempt_row.account_id = receipt.account_id
          AND attempt_row.workspace_id = receipt.workspace_id
          AND attempt_row.session_id = receipt.session_id
          AND attempt_row.turn_id = receipt.turn_id
          AND attempt_row.id = p_attempt_id
      )
    )
    AND (
      p_before_created_at IS NULL
      OR (receipt.created_at, receipt.id) < (p_before_created_at, p_before_id)
    )
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT p_limit;
END;
$$;

DO $function_access$
DECLARE
  data_schema text := pg_catalog.current_schema();
BEGIN
  IF pg_catalog.to_regclass(pg_catalog.format('%I.company_brain_context_selection_receipts', data_schema))
      IS NULL
    OR pg_catalog.to_regclass(pg_catalog.format('%I.session_turns', data_schema)) IS NULL
    OR pg_catalog.to_regclass(pg_catalog.format('%I.session_turn_attempts', data_schema)) IS NULL
    OR pg_catalog.to_regprocedure(
      pg_catalog.format('%I.session_reference_visible(uuid,uuid,uuid)', data_schema)
    ) IS NULL
  THEN
    RAISE EXCEPTION 'Company Brain receipt inspection predecessor authority is incomplete'
      USING ERRCODE = '42P01';
  END IF;

  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.company_brain_inspect_context_receipts('
      || 'uuid,uuid,text,uuid,timestamptz,uuid,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    data_schema, data_schema
  );
  EXECUTE pg_catalog.format(
    'REVOKE ALL ON FUNCTION %I.company_brain_inspect_context_receipts('
      || 'uuid,uuid,text,uuid,timestamptz,uuid,integer) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %I.company_brain_inspect_context_receipts('
        || 'uuid,uuid,text,uuid,timestamptz,uuid,integer) TO opengeni_app',
      data_schema
    );
  END IF;
END
$function_access$;
