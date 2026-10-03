-- deployment-mode: rolling
-- Repair already-applied #2768 draft databases as well as fresh installations.
-- Payer grouping remains uncapped and credits still take precedence. No charges,
-- facts, policies, signatures or ACLs change.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $claude_payers$
DECLARE
  definition text;
  original text;
  old_expression text := $old$WHEN provider IN ('codex-subscription', 'supergrok-subscription') THEN 'subscription'$old$;
  new_expression text := $new$WHEN provider IN ('codex-subscription', 'supergrok-subscription',
            'workspace-claude-subscription', 'organization-claude-subscription') THEN 'subscription'$new$;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_model_usage_summary(uuid,timestamptz,timestamptz,uuid)'::regprocedure)
    INTO original;
  definition := replace(original, old_expression, new_expression);
  IF position(new_expression IN definition) = 0 OR position(old_expression IN definition) > 0 THEN
    RAISE EXCEPTION 'Claude payer classification source contract changed' USING ERRCODE = '55000';
  END IF;
  IF definition IS DISTINCT FROM original THEN
    EXECUTE definition;
  END IF;
END
$claude_payers$;

RESET statement_timeout;
RESET lock_timeout;