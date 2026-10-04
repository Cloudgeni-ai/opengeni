-- deployment-mode: rolling
-- Only private-owner attribution needs per-session groups. Do not sort every
-- account ledger row before discovering which sessions may be attributed.
-- The independent all-row totals query, capability lifecycle, ACL and wire
-- contract remain unchanged; missing/deleted sessions still count in totals.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $private_ledger_filter$
DECLARE
  original text;
  definition text;
  old_head text;
  old_tail text;
  new_tail text;
BEGIN
  SELECT pg_get_functiondef('opengeni_private.organization_usage_summary(uuid,timestamptz,timestamptz,text,uuid,boolean)'::regprocedure)
    INTO original;
  old_head := format($old$WITH usage_by_session AS MATERIALIZED (
          SELECT workspace_id, session_id, event_type, unit, sum(quantity) AS quantity, count(*) AS event_count
          FROM %I.usage_events
          WHERE account_id = context_account_id AND session_id IS NOT NULL
            AND occurred_at >= p_since AND occurred_at < p_until
          GROUP BY workspace_id, session_id, event_type, unit
        ), private_sessions AS MATERIALIZED ($old$, current_schema());
  old_tail := format($old$AND NOT %I.session_private_actor_visible(session_row.account_id, session_row.workspace_id,
              session_row.owner_organization_membership_id, session_row.owner_subject_id)
        ), owner_totals AS ($old$, current_schema());
  new_tail := format($new$AND NOT %1$I.session_private_actor_visible(session_row.account_id, session_row.workspace_id,
              session_row.owner_organization_membership_id, session_row.owner_subject_id)
        ), usage_by_session AS MATERIALIZED (
          SELECT usage_row.workspace_id, usage_row.session_id, usage_row.event_type, usage_row.unit,
            sum(usage_row.quantity) AS quantity, count(*) AS event_count
          FROM %1$I.usage_events usage_row
          JOIN private_sessions matched_session ON matched_session.id = usage_row.session_id
            AND matched_session.workspace_id = usage_row.workspace_id
          WHERE usage_row.account_id = context_account_id
            AND usage_row.occurred_at >= p_since AND usage_row.occurred_at < p_until
          GROUP BY usage_row.workspace_id, usage_row.session_id, usage_row.event_type, usage_row.unit
        ), owner_totals AS ($new$, current_schema());
  IF position(old_head IN original) = 0 OR position(old_tail IN original) = 0 THEN
    RAISE EXCEPTION 'Private ledger filter source contract changed' USING ERRCODE = '55000';
  END IF;
  definition := replace(original, old_head, 'WITH private_sessions AS MATERIALIZED (');
  definition := replace(definition, old_tail, new_tail);
  IF definition = original OR position(old_head IN definition) > 0
    OR position(new_tail IN definition) = 0
    OR position('sum(usage_row.event_count) AS event_count' IN definition) = 0 THEN
    RAISE EXCEPTION 'Private ledger filter did not preserve attributed event counts' USING ERRCODE = '55000';
  END IF;
  EXECUTE definition;
END
$private_ledger_filter$;

RESET statement_timeout;
RESET lock_timeout;