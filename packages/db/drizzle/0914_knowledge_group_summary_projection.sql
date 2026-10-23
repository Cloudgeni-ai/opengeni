-- deployment-mode: rolling
-- The summary consumes only group IDs. Use the existing visibility helper with
-- just that input rather than cloning content and filtering unused relationships.
-- Full entry reads retain their complete projection and all existing ACL checks.
DO $projection$
DECLARE
  definition text := pg_get_functiondef('knowledge_entry_read(uuid,uuid,jsonb,jsonb)'::regprocedure);
  anchor text := $anchor$'groupIds',knowledge_entry_visible_body(p_account,c.body,pending)->'groupIds'$anchor$;
BEGIN
  IF (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 THEN
    RAISE EXCEPTION 'Knowledge group summary source contract changed';
  END IF;
  definition:=replace(definition,anchor,
    $replacement$'groupIds',knowledge_entry_visible_body(p_account,jsonb_build_object('groupIds',coalesce(c.body->'groupIds','[]'::jsonb)),pending)->'groupIds'$replacement$);
  -- pg_get_functiondef retains the existing hardened search_path and volatility;
  -- CREATE OR REPLACE retains ownership and grants. No new helper or privilege.
  EXECUTE definition;
END
$projection$;
