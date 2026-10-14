-- deployment-mode: rolling
-- Additive list/search filter on original entry creation, not revision/update
-- time. Existing binaries omit the parameter and retain their exact behavior.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $migration$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor := $old$      AND (NOT(p_request ? 'entryId') OR e.id=(p_request->>'entryId')::uuid)$old$;
  replacement := anchor || $new$
      -- Filter the authorized candidate set before keyword/vector ranking and
      -- take+one pagination, consistently for every list view and scope.
      AND (operation<>'list' OR NOT(p_request ? 'createdSince')
        OR e.created_at >= (p_request->>'createdSince')::timestamptz)$new$;
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 THEN
    RAISE EXCEPTION 'Knowledge creation-date candidate anchor changed';
  END IF;
  EXECUTE replace(definition,anchor,replacement);
END $migration$;

-- pg_get_functiondef preserves the owner, SECURITY DEFINER and hardened
-- search_path; CREATE OR REPLACE preserves the existing function ACLs. No new
-- grants, indexes, content backfills or changes to visibility are required.
