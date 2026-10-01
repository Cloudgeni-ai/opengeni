-- deployment-mode: rolling
-- A scheduled task that carries `agentConfig.agent` freezes the resolved agent
-- configuration (and any `agent.instructions` alias) in its accepted execution
-- and writes it through to the generated session. Session create records the
-- replay identity of that configuration under the reserved metadata key
-- `_opengeni_session_create_agent_config_v1` and stores the configuration in
-- `sessions.agent_config` (0559). The generated-session identity fence still
-- demanded the legacy shape (exact pre-0559 metadata and NULL instructions), so
-- binding every agent-configured generated session was refused as an authority
-- proof failure.
--
-- Bind the generated session to the accepted execution instead: instructions
-- must equal the frozen `resolvedAgentInstructions`, `agent_config` must equal
-- the frozen `resolvedAgentConfig`, and the expected metadata includes the
-- create replay identity (the resolved configuration without its bookkeeping
-- `source` label) exactly when a configuration was resolved. A legacy accepted
-- execution has neither field, so its expectations are unchanged: NULL
-- instructions, NULL agent_config and the exact legacy metadata. Older workers
-- only produce legacy executions. No table, grant, caller, or runtime-posture
-- contract changes. Every other generated-session identity check is preserved
-- byte for byte; the installed header (SECURITY DEFINER search_path) is kept.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $scheduled_generated_session_agent_config_fence$
DECLARE
  definition text;
  next_definition text;
  old_instructions constant text := $old$OR session_row.instructions IS NOT NULL
$old$;
  new_instructions constant text := $new$OR session_row.instructions
          IS DISTINCT FROM accepted ->> 'resolvedAgentInstructions'
        OR session_row.agent_config IS DISTINCT FROM (CASE
          WHEN accepted -> 'resolvedAgentConfig' = 'null'::jsonb THEN NULL
          ELSE accepted -> 'resolvedAgentConfig'
        END)
$new$;
  old_metadata constant text := $old$      IF generated_binding = 'null'::jsonb
$old$;
  new_metadata constant text := $new$      IF accepted -> 'resolvedAgentConfig' IS NOT NULL
        AND accepted -> 'resolvedAgentConfig' <> 'null'::jsonb THEN
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            '_opengeni_session_create_agent_config_v1',
            (accepted -> 'resolvedAgentConfig') - 'source'
          );
      END IF;
      IF generated_binding = 'null'::jsonb
$new$;
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'fence_scheduled_task_run_connection_session_identity()'::regprocedure
  );
  IF pg_catalog.strpos(definition, 'resolvedAgentInstructions') > 0 THEN
    -- Replay: the exact replacement is already installed.
    RETURN;
  END IF;
  IF (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_instructions, '')))
      <> pg_catalog.length(old_instructions)
    OR (pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, old_metadata, '')))
      <> pg_catalog.length(old_metadata)
  THEN
    RAISE EXCEPTION '0561 scheduled generated-session fence changed before agent config binding'
      USING ERRCODE = '55000';
  END IF;
  next_definition := pg_catalog.replace(definition, old_instructions, new_instructions);
  next_definition := pg_catalog.replace(next_definition, old_metadata, new_metadata);
  EXECUTE next_definition;
END
$scheduled_generated_session_agent_config_fence$;
