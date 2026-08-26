-- deployment-mode: rolling
-- The durable company-profile storage contract retains its historical list
-- fields for revision compatibility, but new product surfaces use only the
-- small always-on organization identity and mission. Existing proposal rows
-- keep their immutable human-input payload; only proposals prepared after this
-- migration receive the narrowed confirmation copy.

CREATE OR REPLACE FUNCTION company_profile_agent_confirmation_summary(p_content_json text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
AS $body$
DECLARE
  profile jsonb := p_content_json::jsonb;
  summary text;
  list_name text;
  list_text text;
BEGIN
  summary := 'Identity: ' || coalesce(nullif(btrim(profile->>'identity'), ''), '(none)')
    || E'\nMission: ' || coalesce(nullif(btrim(profile->>'mission'), ''), '(none)');
  -- Rolling compatibility: old API instances may still submit these fields.
  -- Never hide nonempty content from the human confirmation. New instances
  -- submit empty arrays, so the narrowed identity UI remains concise.
  FOREACH list_name IN ARRAY ARRAY['products', 'customers', 'goals', 'constraints'] LOOP
    IF jsonb_array_length(coalesce(profile->list_name, '[]'::jsonb)) > 0 THEN
      SELECT string_agg('- ' || (item->>'key') || ': ' || (item->>'content'), E'\n'
        ORDER BY entries.ordinality)
      INTO list_text
      FROM jsonb_array_elements(profile->list_name)
        WITH ORDINALITY AS entries(item, ordinality);
      summary := summary || E'\nLegacy ' || initcap(list_name)
        || ' (retained compatibility context):' || E'\n' || list_text;
    END IF;
  END LOOP;
  -- HumanInputQuestion.helpText is capped at 2048 UTF-16 code units; the
  -- revision/hash prefix uses under 100. Bound the rendered bytes (a UTF-16
  -- unit never needs more bytes than it needs units) without splitting a
  -- character.
  IF octet_length(summary) > 1800 THEN
    WHILE octet_length(summary) > 1797 LOOP
      summary := left(
        summary,
        length(summary) - greatest(1, (octet_length(summary) - 1797) / 4)
      );
    END LOOP;
    summary := summary || '...';
  END IF;
  RETURN summary;
END
$body$;

CREATE OR REPLACE FUNCTION company_profile_agent_confirmation_prompt(
  p_revision_id uuid,
  p_revision bigint,
  p_content_hash text,
  p_content_json text
) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $body$
  SELECT jsonb_build_object(
    'questions', jsonb_build_array(jsonb_build_object(
      'id', 'company-profile:' || p_revision_id::text,
      'kind', 'single_select',
      'prompt', CASE
        WHEN jsonb_array_length(coalesce((p_content_json::jsonb)->'products', '[]'::jsonb))
           + jsonb_array_length(coalesce((p_content_json::jsonb)->'customers', '[]'::jsonb))
           + jsonb_array_length(coalesce((p_content_json::jsonb)->'goals', '[]'::jsonb))
           + jsonb_array_length(coalesce((p_content_json::jsonb)->'constraints', '[]'::jsonb)) > 0
          THEN 'Activate this organization identity and retained legacy details?'
        ELSE 'Activate this organization identity and mission?'
      END,
      'label', 'Organization identity',
      'helpText', 'Revision ' || p_revision::text || '; SHA-256 ' || p_content_hash
        || E'.\n\n' || company_profile_agent_confirmation_summary(p_content_json),
      'options', jsonb_build_array(
        jsonb_build_object('id', 'activate', 'label', 'Activate'),
        jsonb_build_object('id', 'skip', 'label', 'Do not activate')
      ),
      'required', true,
      'allowOther', true
    )),
    'allowSkip', false
  )
$body$;

-- CREATE OR REPLACE resets per-function configuration. Restore the pinned
-- search path installed by migration 0324 so these helpers retain the same
-- schema-agnostic hardening after the rolling replacement.
DO $organization_identity_confirmation_hardening$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_confirmation_summary(text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.company_profile_agent_confirmation_prompt(uuid,bigint,text,text) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema, target_schema
  );
END
$organization_identity_confirmation_hardening$;
