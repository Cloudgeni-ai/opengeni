-- deployment-mode: rolling
-- Preserve UUID::text equality, including its rejection of noncanonical UUID
-- spellings, while leaving the indexed UUID column bare. Existing lower()
-- normalization stays only where the previous comparison already used it.
-- Patch the installed bodies so later authority checks remain unchanged.
-- Inline CASE avoids adding a routine to the rolling runtime-posture contract.
DO $indexed_lineage$
DECLARE
  site record;
  definition text;
  anchor text;
  replacement text;
BEGIN
  FOR site IN SELECT * FROM (VALUES
    ('opengeni_private.fence_mcp_account_bindings()', 'origin.id',
      $value$CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerTurnId'
            WHEN update_value.kind LIKE 'child_%'
              THEN update_value.lineage ->> 'parentTurnId'
            ELSE update_value.lineage ->> 'causalTurnId' END$value$),
    ('opengeni_private.fence_mcp_account_bindings()', 'origin.session_id',
      $value$CASE
            WHEN update_value.kind IN ('agent_message','agent_steer_instruction')
              THEN update_value.lineage ->> 'callerSessionId'
            ELSE document ->> 'session_id' END$value$),
    ('opengeni_private.fence_inbox_execution_context()', 't.id',
      $value$CASE WHEN u.kind = 'agent_message' THEN u.lineage ->> 'callerTurnId'
        WHEN u.kind LIKE 'child_%' THEN u.lineage ->> 'parentTurnId' ELSE u.lineage ->> 'causalTurnId' END$value$),
    ('opengeni_private.fence_inbox_execution_context()', 't.session_id',
      $value$CASE WHEN u.kind = 'agent_message' THEN u.lineage ->> 'callerSessionId'
        ELSE NEW.session_id::text END$value$),
    ('opengeni_subscription_internal.subscription_compat_delivery_sources(uuid,uuid,uuid,uuid,text)',
      'causal.id', $value$lower(first_delivered.lineage->>'causalTurnId')$value$),
    ('opengeni_subscription_internal.subscription_compat_carrier_sources(text,uuid,uuid,bigint)',
      'edited.id', $value$lower(turn_row.lineage->>'editedFromTurnId')$value$),
    ('opengeni_subscription_internal.subscription_compat_carrier_sources(text,uuid,uuid,bigint)',
      'caller.id', $value$lower(update_row.lineage->>'callerTurnId')$value$),
    ('opengeni_subscription_internal.subscription_compat_carrier_sources(text,uuid,uuid,bigint)',
      'caller.session_id', $value$lower(update_row.lineage->>'callerSessionId')$value$)
  ) AS sites(function_name, column_name, value_expression)
  LOOP
    definition := pg_get_functiondef(site.function_name::regprocedure);
    anchor := site.column_name || '::text = ' || site.value_expression;
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION 'indexed lineage migration: expected one % anchor in %',
        site.column_name, site.function_name;
    END IF;
    replacement := format(
      '%s = CASE WHEN pg_catalog.octet_length((%s)) = 36 AND (%s) COLLATE pg_catalog."C" OPERATOR(pg_catalog.~) ''^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'' THEN (%s)::pg_catalog.uuid END',
      site.column_name, site.value_expression, site.value_expression, site.value_expression);
    EXECUTE replace(definition, anchor, replacement);
  END LOOP;
END
$indexed_lineage$;
