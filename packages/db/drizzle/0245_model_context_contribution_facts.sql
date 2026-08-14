-- deployment-mode: rolling
-- Persist the existing content-free Company Brain contribution estimate beside
-- each authoritative model-call fact so Workspace Insights can report it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "model_call_facts"
  ADD COLUMN IF NOT EXISTS "context_contributions" jsonb;

CREATE OR REPLACE FUNCTION opengeni_private.model_context_contributions_valid(value jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  contribution jsonb;
  contribution_source text;
  metric text;
  seen_sources text[] := ARRAY[]::text[];
BEGIN
  IF value IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(value) <> 'array'
    OR jsonb_array_length(value) > 6
    OR octet_length(value::text) > 8192
  THEN
    RETURN false;
  END IF;

  FOR contribution IN SELECT element FROM jsonb_array_elements(value) AS entries(element)
  LOOP
    IF jsonb_typeof(contribution) <> 'object'
      OR jsonb_object_length(contribution) <> 4
      OR NOT (contribution ?& ARRAY['source', 'items', 'utf8Bytes', 'estimatedTokens'])
    THEN
      RETURN false;
    END IF;

    contribution_source := contribution->>'source';
    IF contribution_source NOT IN (
      'workspace_instruction_policy',
      'legacy_workspace_instructions',
      'preference_registry_descriptor',
      'company_profile',
      'legacy_memory_v1',
      'runtime_skill_catalog'
    ) OR contribution_source = ANY(seen_sources)
    THEN
      RETURN false;
    END IF;
    seen_sources := array_append(seen_sources, contribution_source);

    FOREACH metric IN ARRAY ARRAY['items', 'utf8Bytes', 'estimatedTokens']
    LOOP
      IF jsonb_typeof(contribution->metric) <> 'number'
        OR contribution->>metric !~ '^(0|[1-9][0-9]{0,15})$'
        OR (contribution->>metric)::numeric > 9007199254740991
      THEN
        RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE "model_call_facts"
  DROP CONSTRAINT IF EXISTS "model_call_facts_context_contributions_check",
  ADD CONSTRAINT "model_call_facts_context_contributions_check"
  CHECK (opengeni_private.model_context_contributions_valid("context_contributions")) NOT VALID;

ALTER TABLE "model_call_facts"
  VALIDATE CONSTRAINT "model_call_facts_context_contributions_check";
