-- deployment-mode: rolling
-- Preserve the installed complete-ledger, Personal-workspace, private-owner,
-- capability and query-plan contracts. Only internal reservation rows disappear
-- from amount aggregates; customer usage and debit facts remain unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $reservation_summary$
DECLARE
  original text;
  definition text;
  anchor text := 'AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until';
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure)
  INTO original;
  -- Both the full-ledger scan and private-owner scan must exclude holds.
  IF array_length(string_to_array(original, anchor), 1) <> 3
    OR position('''personalWorkspaces''' IN original) = 0
    OR position('''privateChatsTruncated''' IN original) = 0
    OR position('usage_by_session AS MATERIALIZED' IN original) = 0
    OR position('close_session_tenancy_fence_inventory' IN original) = 0
    OR position('enable_nestloop' IN original) = 0 THEN
    RAISE EXCEPTION 'Usage reservation summary source contract changed' USING ERRCODE = '55000';
  END IF;
  definition := replace(original, anchor,
    anchor || ' AND usage_row.event_type NOT LIKE ''%.reserved''');
  EXECUTE definition;
END
$reservation_summary$;
