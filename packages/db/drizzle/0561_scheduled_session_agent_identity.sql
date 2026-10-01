-- deployment-mode: rolling
-- Generated scheduled sessions retain their accepted agent configuration,
-- instructions and canonical immutable create identity. Keep the binding
-- proof exact: the new metadata key is derived from accepted execution, not
-- ignored or trusted from task/user metadata. Legacy snapshots remain null.
DO $migration$
DECLARE
  target regprocedure := 'fence_scheduled_task_run_connection_session_identity()'::regprocedure;
  definition text := pg_get_functiondef(target);
  metadata_anchor text := $before$      IF generated_binding = 'null'::jsonb$before$;
  metadata_replacement text := $after$      expected_generated_metadata := expected_generated_metadata
        - '_opengeni_session_create_agent_config_v1';
      IF accepted -> 'resolvedAgentConfig' IS NOT NULL
        AND accepted -> 'resolvedAgentConfig' <> 'null'::jsonb THEN
        expected_generated_metadata := expected_generated_metadata
          || pg_catalog.jsonb_build_object(
            '_opengeni_session_create_agent_config_v1',
            (accepted -> 'resolvedAgentConfig') - 'source'
          );
      END IF;
      IF generated_binding = 'null'::jsonb$after$;
  instructions_anchor text := 'OR session_row.instructions IS NOT NULL';
  instructions_replacement text := $after$OR session_row.instructions IS DISTINCT FROM
          accepted ->> 'resolvedAgentInstructions'
        OR session_row.agent_config IS DISTINCT FROM
          nullif(accepted -> 'resolvedAgentConfig', 'null'::jsonb)$after$;
BEGIN
  IF (length(definition) - length(replace(definition, metadata_anchor, '')))
      / length(metadata_anchor) <> 1
    OR (length(definition) - length(replace(definition, instructions_anchor, '')))
      / length(instructions_anchor) <> 1 THEN
    RAISE EXCEPTION 'scheduled generated agent identity source contract changed';
  END IF;
  definition := replace(definition, metadata_anchor, metadata_replacement);
  definition := replace(definition, instructions_anchor, instructions_replacement);
  EXECUTE definition;
END
$migration$;