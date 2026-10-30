-- deployment-mode: rolling
-- Teach Insights payer grouping the canonical Claude subscription provider id
-- (`claude-subscription`) before any writer records it. Hourly rollups store the
-- payer at write time, so this must land one release before the catalog emits
-- `claude/<model>` ids. The legacy workspace/organization provider ids keep their
-- meaning. No charges, facts, policies, signatures, owners or ACLs change, and the
-- rewrite is idempotent.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $claude_canonical_payer$
DECLARE
  definition text;
  original text;
  old_summary text := $old$'workspace-claude-subscription', 'organization-claude-subscription') THEN 'subscription'$old$;
  new_summary text := $new$'workspace-claude-subscription', 'organization-claude-subscription', 'claude-subscription') THEN 'subscription'$new$;
  old_payer text := $old$'workspace-claude-subscription','organization-claude-subscription')$old$;
  new_payer text := $new$'workspace-claude-subscription','organization-claude-subscription','claude-subscription')$new$;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)'::regprocedure)
    INTO original;
  definition := replace(original, old_summary, new_summary);
  IF position(new_summary IN definition) = 0 OR position(old_summary IN definition) > 0 THEN
    RAISE EXCEPTION 'Claude usage summary payer source contract changed' USING ERRCODE = '55000';
  END IF;
  IF definition IS DISTINCT FROM original THEN
    EXECUTE definition;
  END IF;

  SELECT pg_get_functiondef('opengeni_private.insights_usage_payer(text,text)'::regprocedure)
    INTO original;
  definition := replace(original, old_payer, new_payer);
  IF position(new_payer IN definition) = 0 OR position(old_payer IN definition) > 0 THEN
    RAISE EXCEPTION 'Insights payer source contract changed' USING ERRCODE = '55000';
  END IF;
  IF definition IS DISTINCT FROM original THEN
    EXECUTE definition;
  END IF;
END
$claude_canonical_payer$;

RESET statement_timeout;
RESET lock_timeout;
