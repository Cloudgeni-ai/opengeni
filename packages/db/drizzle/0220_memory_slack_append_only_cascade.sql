-- deployment-mode: rolling
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- Configuration revisions and delivery receipts remain immutable while their
-- workspace exists. Parent account/workspace deletion must still be able to
-- cascade through that history, including on embedded non-public schemas.
CREATE OR REPLACE FUNCTION opengeni_private.reject_memory_slack_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  workspace_exists boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %I.workspaces WHERE id = $1)',
      TG_TABLE_SCHEMA
    )
      INTO workspace_exists
      USING OLD.workspace_id;
    IF NOT workspace_exists THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;

REVOKE ALL ON FUNCTION opengeni_private.reject_memory_slack_immutable_mutation()
  FROM PUBLIC;
