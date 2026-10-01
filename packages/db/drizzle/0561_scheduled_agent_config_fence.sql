-- deployment-mode: rolling
-- Generated scheduled sessions must match the complete accepted agent config,
-- its instruction alias, and its creation identity. Legacy NULL snapshots keep
-- the same fence. Replace only the reviewed body; retain the installed owner,
-- grants, SECURITY DEFINER header, and schema-scoped search_path.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $scheduled_agent_config_fence$
DECLARE
  definition text;
  current_body text;
  replacement_body text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(oid), prosrc
  INTO STRICT definition, current_body
  FROM pg_catalog.pg_proc
  WHERE oid = 'fence_scheduled_task_run_connection_session_identity()'::regprocedure;
  IF pg_catalog.md5(current_body) = '0d06e447f066d5847709239357b0f1d6' THEN
    RETURN;
  END IF;
  IF pg_catalog.md5(current_body) IS DISTINCT FROM '6ab8f3dcac4fba962f65ac405aba5bed' THEN
    RAISE EXCEPTION '0561 scheduled agent config fence prerequisite definition drift'
      USING ERRCODE = '55000';
  END IF;
  replacement_body := current_body;
  replacement_body := pg_catalog.replace(replacement_body,
    $old0$- 'opengeniSlackBotConnectionId')$old0$,
    $new0$- 'opengeniSlackBotConnectionId' - '_opengeni_session_create_agent_config_v1')$new0$
  );
  replacement_body := pg_catalog.replace(replacement_body,
    $old1$      IF generated_binding = 'null'::jsonb$old1$,
    $new1$      IF accepted -> 'resolvedAgentConfig' IS NOT NULL
        AND accepted -> 'resolvedAgentConfig' <> 'null'::jsonb
      THEN
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            '_opengeni_session_create_agent_config_v1',
            (accepted -> 'resolvedAgentConfig') - 'source'
          );
      END IF;
      IF generated_binding = 'null'::jsonb$new1$
  );
  replacement_body := pg_catalog.replace(replacement_body,
    $old2$OR session_row.instructions IS NOT NULL$old2$,
    $new2$OR session_row.instructions IS DISTINCT FROM accepted ->> 'resolvedAgentInstructions'
        OR session_row.agent_config IS DISTINCT FROM
          nullif(accepted -> 'resolvedAgentConfig', 'null'::jsonb)$new2$
  );
  IF pg_catalog.md5(replacement_body) IS DISTINCT FROM '0d06e447f066d5847709239357b0f1d6' THEN
    RAISE EXCEPTION '0561 scheduled agent config fence replacement definition drift'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE pg_catalog.replace(definition, current_body, replacement_body);
END
$scheduled_agent_config_fence$;
