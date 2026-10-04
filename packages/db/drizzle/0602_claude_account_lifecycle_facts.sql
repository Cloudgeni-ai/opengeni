-- deployment-mode: rolling
-- 0598 clones the account INSERT trigger, but the shared dispatcher still only
-- recognizes the xAI source table. Add the same content-free Claude branch;
-- preserve the existing schema fence, deduplication and failure isolation.
DO $migration$
DECLARE
  definition text;
  source_branch text := $source$WHEN 'xai_subscription_credentials' THEN
            SELECT 'model.connected', 'supergrok', NEW.connected_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;$source$;
  claude_branch text;
BEGIN
  SELECT pg_get_functiondef(
    'opengeni_private.capture_product_lifecycle_fact()'::regprocedure
  ) INTO definition;
  IF position(source_branch IN definition) = 0
    OR position('WHEN ''claude_subscription_credentials'' THEN' IN definition) <> 0 THEN
    RAISE EXCEPTION 'product lifecycle account capture contract changed'
      USING ERRCODE = '55000';
  END IF;
  claude_branch := replace(replace(source_branch,
    'xai_subscription_credentials', 'claude_subscription_credentials'),
    '''supergrok''', '''claude_subscription''');
  EXECUTE replace(definition, source_branch, source_branch || E'\n          ' || claude_branch);
END
$migration$;