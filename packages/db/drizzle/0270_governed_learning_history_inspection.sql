-- deployment-mode: rolling
-- Migration 0270: exact-human, content-free governed-learning inspection.
-- The immutable receipt tables stay runtime-inaccessible. These bounded,
-- read-only capabilities expose only receipts belonging to the current human.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION inspect_governed_learning_decisions(
  p_account_id uuid,
  p_workspace_id uuid,
  p_subject_id text,
  p_limit integer DEFAULT 50
) RETURNS SETOF governed_learning_decision_receipts
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
    OR pg_catalog.current_setting('opengeni.principal_kind', true) IS DISTINCT FROM 'human_session'
  THEN
    RAISE EXCEPTION 'governed-learning inspection requires exact human tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION 'governed-learning inspection has invalid bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT receipt.*
  FROM governed_learning_decision_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = p_subject_id
    AND session_reference_visible(
      receipt.account_id, receipt.workspace_id, receipt.session_id
    )
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION inspect_governed_learning_activations(
  p_account_id uuid,
  p_workspace_id uuid,
  p_subject_id text,
  p_limit integer DEFAULT 50
) RETURNS SETOF governed_learning_activation_receipts
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
    OR pg_catalog.current_setting('opengeni.principal_kind', true) IS DISTINCT FROM 'human_session'
  THEN
    RAISE EXCEPTION 'governed-learning inspection requires exact human tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION 'governed-learning inspection has invalid bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT receipt.*
  FROM governed_learning_activation_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = p_subject_id
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION inspect_governed_learning_activation_undos(
  p_account_id uuid,
  p_workspace_id uuid,
  p_subject_id text,
  p_limit integer DEFAULT 50
) RETURNS SETOF governed_learning_activation_undo_receipts
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
    OR pg_catalog.current_setting('opengeni.principal_kind', true) IS DISTINCT FROM 'human_session'
  THEN
    RAISE EXCEPTION 'governed-learning inspection requires exact human tenant authority'
      USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 101 THEN
    RAISE EXCEPTION 'governed-learning inspection has invalid bounds'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT receipt.*
  FROM governed_learning_activation_undo_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_workspace_id
    AND receipt.initiating_human_subject_id = p_subject_id
  ORDER BY receipt.created_at DESC, receipt.id DESC
  LIMIT p_limit;
END;
$$;

DO $function_access$
DECLARE
  data_schema text := pg_catalog.current_schema();
  signature text;
BEGIN
  IF pg_catalog.to_regclass(
      pg_catalog.format('%I.governed_learning_decision_receipts', data_schema)
    ) IS NULL
    OR pg_catalog.to_regclass(
      pg_catalog.format('%I.governed_learning_activation_receipts', data_schema)
    ) IS NULL
    OR pg_catalog.to_regclass(
      pg_catalog.format('%I.governed_learning_activation_undo_receipts', data_schema)
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      pg_catalog.format('%I.session_reference_visible(uuid,uuid,uuid)', data_schema)
    ) IS NULL
  THEN
    RAISE EXCEPTION 'governed-learning inspection predecessor authority is incomplete'
      USING ERRCODE = '42P01';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    'inspect_governed_learning_decisions(uuid,uuid,text,integer)',
    'inspect_governed_learning_activations(uuid,uuid,text,integer)',
    'inspect_governed_learning_activation_undos(uuid,uuid,text,integer)'
  ] LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp',
      data_schema, signature, data_schema
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, signature
    );
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app') THEN
      EXECUTE pg_catalog.format(
        'GRANT EXECUTE ON FUNCTION %I.%s TO opengeni_app', data_schema, signature
      );
    END IF;
  END LOOP;
END
$function_access$;
