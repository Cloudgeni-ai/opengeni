-- deployment-mode: rolling
-- Member share ceilings in threshold and exhaustion notifications are shares
-- of the period's whole pool: included credits plus the grants spent this
-- period plus those still left, the same pool as the workspace ceiling.
-- Before, a member's share was of included credits plus the grants still
-- left, so every credit anyone spent from a grant lowered every member's
-- ceiling, while their usage still counted the whole period.
--
-- Only the body of emit_usage_allowance_notifications changes; its
-- signature, owner, grants and settings stay. The previous release computes
-- admission and reads in its own code and only calls this function.
SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
  definition text;
  edit text[];
  edits text[] := ARRAY[
    ARRAY[$a$  pool:=(p_config->>'includedCredits')::bigint+grant_remaining;$a$,
      $a$  pool:=(p_config->>'includedCredits')::bigint+grant_remaining+coalesce((SELECT grants_used
    FROM opengeni_private.workspace_allowance_counters
    WHERE workspace_id=p_workspace AND period_key=p_period AND subject_id=''),0);$a$],
    ARRAY[$a$      cap:=pool+c.grants_used;$a$, $a$      cap:=pool;$a$]
  ];
BEGIN
  definition := pg_catalog.pg_get_functiondef(pg_catalog.format(
    '%I.emit_usage_allowance_notifications(uuid,uuid,jsonb,text,timestamptz,text)',
    pg_catalog.current_schema())::regprocedure);
  IF strpos(definition, 'SELECT grants_used') > 0 THEN
    RETURN;
  END IF;
  FOREACH edit SLICE 1 IN ARRAY edits LOOP
    IF (length(definition) - length(replace(definition, edit[1], ''))) / length(edit[1]) <> 1 THEN
      RAISE EXCEPTION '1165 usage allowance notifications drift at %', edit[1]
        USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, edit[1], edit[2]);
  END LOOP;
  EXECUTE definition;
END
$migration$;
