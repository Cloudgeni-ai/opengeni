-- deployment-mode: rolling
-- A retained process now records the oldest reconciler that understands how
-- to reach it. Docker and local commands under the in-sandbox supervisor are
-- version 2: a worker built before that supervisor would read one through its
-- own in-memory SDK table, find nothing and settle a live command as lost.
--
-- Workers keep calling the claim they were built with. The original
-- three-argument claim becomes the version 1 claim and never returns a newer
-- row, so during a rolling deploy an older reaper simply leaves those rows to
-- a newer one. The four-argument claim takes the caller's version.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE sandbox_retained_processes
  ADD COLUMN IF NOT EXISTS reconciler_version smallint NOT NULL DEFAULT 1;
ALTER TABLE sandbox_retained_processes
  DROP CONSTRAINT IF EXISTS sandbox_retained_processes_reconciler_version_check;
ALTER TABLE sandbox_retained_processes
  ADD CONSTRAINT sandbox_retained_processes_reconciler_version_check
  CHECK (reconciler_version >= 1) NOT VALID;
ALTER TABLE sandbox_retained_processes
  VALIDATE CONSTRAINT sandbox_retained_processes_reconciler_version_check;

DO $install$
DECLARE
  target_schema text := current_schema();
  legacy constant text :=
    'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)';
  versioned constant text :=
    'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint,integer)';
  legacy_header constant text :=
    'claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint)';
  versioned_header constant text :=
    'claim_terminal_retained_processes(p_claim_id uuid, p_limit integer, p_claim_ttl_ms bigint, p_reconciler_version integer)';
  due_filter constant text :=
    E'          AND process.reconcile_after <= pg_catalog.now()\n';
  version_filter constant text :=
    E'          AND process.reconcile_after <= pg_catalog.now()\n'
    || E'          AND process.reconciler_version <= p_reconciler_version\n';
  argument_guard constant text := E'    BEGIN\n      IF p_limit < 1 OR p_limit > 100 THEN';
  versioned_guard constant text :=
    E'    BEGIN\n'
    || E'      IF p_reconciler_version IS NULL OR p_reconciler_version < 1 THEN\n'
    || E'        RAISE EXCEPTION ''retained-process reconciler version is invalid''\n'
    || E'          USING ERRCODE = ''22023'';\n'
    || E'      END IF;\n'
    || E'      IF p_limit < 1 OR p_limit > 100 THEN';
  definition text;
  claim_owner text;
  role_name text;
BEGIN
  -- Derive the versioned claim from the installed one, so every earlier
  -- repair to that body (tenancy fences, fenced access) carries over exactly.
  -- A replay finds the legacy claim already a wrapper and keeps the
  -- versioned claim it installed the first time.
  IF pg_catalog.to_regprocedure(versioned) IS NULL THEN
    definition := pg_catalog.pg_get_functiondef(legacy::regprocedure);
    IF (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, legacy_header, '')))
        / pg_catalog.length(legacy_header) <> 1
      OR (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, due_filter, '')))
        / pg_catalog.length(due_filter) <> 1
      OR (pg_catalog.length(definition) - pg_catalog.length(pg_catalog.replace(definition, argument_guard, '')))
        / pg_catalog.length(argument_guard) <> 1
    THEN
      RAISE EXCEPTION '0840 could not derive the versioned retained-process claim'
        USING ERRCODE = '55000';
    END IF;
    definition := pg_catalog.replace(definition, legacy_header, versioned_header);
    definition := pg_catalog.replace(definition, due_filter, version_filter);
    definition := pg_catalog.replace(definition, argument_guard, versioned_guard);
    EXECUTE definition;
  END IF;

  EXECUTE format($wrapper$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_terminal_retained_processes(
      p_claim_id uuid,
      p_limit integer,
      p_claim_ttl_ms bigint
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      session_id uuid,
      process_id uuid,
      claim_id uuid,
      owner_state text,
      owner_attempt_outcome text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      SELECT * FROM opengeni_private.claim_terminal_retained_processes(
        p_claim_id, p_limit, p_claim_ttl_ms, 1
      )
    $body$
  $wrapper$, target_schema);

  -- Same owner and runtime grant set as the claim it versions.
  SELECT pg_catalog.pg_get_userbyid(proowner) INTO STRICT claim_owner FROM pg_catalog.pg_proc
    WHERE oid = legacy::regprocedure;
  EXECUTE format('ALTER FUNCTION %s OWNER TO %I', versioned, claim_owner);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', versioned);
  FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname <> current_user AND pg_catalog.has_function_privilege(oid, legacy, 'EXECUTE')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', versioned, role_name);
  END LOOP;
END $install$;
