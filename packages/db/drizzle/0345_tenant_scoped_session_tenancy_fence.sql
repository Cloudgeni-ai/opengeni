-- deployment-mode: maintenance
SET lock_timeout = '5s';
SET statement_timeout = '10min';

-- opengeni_private contains historical singleton worker routines, so one
-- database can support exactly one dedicated OpenGeni target schema. Bind the
-- protocol before any shared CREATE OR REPLACE or target-schema mutation. A
-- same-target migration-ledger replay is harmless; a different target must
-- stop before it can repin a global routine or install a partial helper set.
CREATE TABLE IF NOT EXISTS opengeni_private.session_tenancy_fence_target_registry (
  singleton boolean NOT NULL,
  target_schema regnamespace NOT NULL,
  CONSTRAINT session_tenancy_fence_target_registry_pk PRIMARY KEY (singleton),
  CONSTRAINT session_tenancy_fence_target_registry_singleton_chk CHECK (singleton)
);

REVOKE ALL ON TABLE
  opengeni_private.session_tenancy_fence_target_registry
  FROM PUBLIC;

DO $session_tenancy_fence_target_registry_contract$
DECLARE
  registry_table oid := pg_catalog.to_regclass(
    'opengeni_private.session_tenancy_fence_target_registry'
  );
  actual_columns text[];
  actual_constraints text[];
  registered_target pg_catalog.regnamespace;
  requested_target pg_catalog.regnamespace :=
    pg_catalog.current_schema()::pg_catalog.regnamespace;
BEGIN
  IF registry_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid = registry_table
      AND relation.relkind = 'r'
      AND relation.relowner = current_user::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION '0345 session tenancy target registry owner/type drift'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(
    attribute.attname || ':'
      || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':'
      || attribute.attnotnull::text
    ORDER BY attribute.attnum
  ) INTO actual_columns
  FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid = registry_table
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'singleton:boolean:true',
    'target_schema:regnamespace:true'
  ]::text[] THEN
    RAISE EXCEPTION '0345 session tenancy target registry column drift'
      USING ERRCODE = '55000', DETAIL = actual_columns::text;
  END IF;
  SELECT pg_catalog.array_agg(
    constraint_value.conname || ':' || constraint_value.contype::text || ':'
      || pg_catalog.pg_get_constraintdef(constraint_value.oid, false)
    ORDER BY constraint_value.conname
  ) INTO actual_constraints
  FROM pg_catalog.pg_constraint constraint_value
  WHERE constraint_value.conrelid = registry_table;
  IF actual_constraints IS DISTINCT FROM ARRAY[
    'session_tenancy_fence_target_registry_pk:p:PRIMARY KEY (singleton)',
    'session_tenancy_fence_target_registry_singleton_chk:c:CHECK (singleton)'
  ]::text[] THEN
    RAISE EXCEPTION '0345 session tenancy target registry constraint drift'
      USING ERRCODE = '55000', DETAIL = actual_constraints::text;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) acl
    WHERE relation.oid = registry_table
      AND acl.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION '0345 session tenancy target registry ACL drift'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO opengeni_private.session_tenancy_fence_target_registry (
    singleton, target_schema
  ) VALUES (true, requested_target)
  ON CONFLICT (singleton) DO NOTHING;

  SELECT registry.target_schema
  INTO registered_target
  FROM opengeni_private.session_tenancy_fence_target_registry registry
  WHERE registry.singleton
  FOR UPDATE;
  IF registered_target IS DISTINCT FROM requested_target THEN
    RAISE EXCEPTION
      '0345 session tenancy target schema is already bound to %, not %',
      registered_target,
      requested_target
      USING ERRCODE = '55000';
  END IF;
END
$session_tenancy_fence_target_registry_contract$;

-- This is a protocol cutover, not merely a convention in the new TypeScript
-- image. Every hot-table mutation must arrive with the workspace fence already
-- held; the trigger deliberately refuses to acquire it after PostgreSQL may
-- have taken a tuple lock. Stop every old API/worker before this migration and
-- never restart a pre-0345 image after it commits.
CREATE OR REPLACE FUNCTION opengeni_private.require_session_tenancy_fence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fence$
DECLARE
  workspace_id_value uuid;
  lock_key bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles role_value
    WHERE role_value.rolname = session_user
      AND (role_value.rolsuper OR role_value.rolbypassrls)
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    workspace_id_value := (to_jsonb(OLD) ->> 'workspace_id')::uuid;
  ELSE
    workspace_id_value := (to_jsonb(NEW) ->> 'workspace_id')::uuid;
  END IF;
  IF workspace_id_value IS NULL THEN
    RAISE EXCEPTION 'session tenancy mutation has no workspace fence target'
      USING ERRCODE = '55000';
  END IF;
  lock_key := hashtextextended('session-tenancy:' || workspace_id_value::text, 0);
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks held
    WHERE held.locktype = 'advisory'
      AND held.pid = pg_backend_pid()
      AND held.granted
      AND held.classid = (((lock_key >> 32) & 4294967295)::bigint)::oid
      AND held.objid = ((lock_key & 4294967295)::bigint)::oid
      AND held.objsubid = 1
      AND held.mode IN ('ShareLock', 'ExclusiveLock')
  ) THEN
    RAISE EXCEPTION 'session tenancy mutation requires the workspace fence'
      USING ERRCODE = '55000', DETAIL = TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fence$;

REVOKE ALL ON FUNCTION opengeni_private.require_session_tenancy_fence() FROM PUBLIC;

-- FORCE RLS also applies to the non-bypass migration owner that owns these
-- SECURITY-DEFINER routines. A global sweep cannot know which workspace
-- fences to take until it can read a bounded workspace-id inventory, so give
-- only the private helpers below an exact-schema/backend/xact-bound read
-- capability. Every open gets an independent token: if an inner helper raises,
-- its insert rolls back before its exception handler runs, so closing that
-- exact token cannot consume an outer helper's authority. The capability is
-- closed before the helper returns any count. Once the fences are held, a
-- second owner-only policy admits the routine's actual reads and mutations for
-- those exact workspaces. opengeni_app cannot mint the capability, and merely
-- acquiring an advisory lock does not satisfy the current_user owner check.
CREATE TABLE IF NOT EXISTS opengeni_private.session_tenancy_fence_inventory_capabilities (
  capability_id uuid PRIMARY KEY,
  target_schema oid NOT NULL,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL
);

REVOKE ALL ON TABLE
  opengeni_private.session_tenancy_fence_inventory_capabilities
  FROM PUBLIC;

-- opengeni_private is shared by dedicated target schemas. A second target may
-- reuse this ledger only when the first target installed the exact owner,
-- shape, primary key, and closed ACL expected here; otherwise stop rather than
-- inheriting ambiguous authority.
DO $session_tenancy_fence_inventory_contract$
DECLARE
  capability_table oid := pg_catalog.to_regclass(
    'opengeni_private.session_tenancy_fence_inventory_capabilities'
  );
  actual_columns text[];
  primary_key_columns text[];
BEGIN
  IF capability_table IS NULL THEN
    RAISE EXCEPTION '0345 session tenancy inventory ledger is missing'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid = capability_table
      AND relation.relkind = 'r'
      AND relation.relowner = current_user::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION '0345 session tenancy inventory ledger owner/type drift'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(
    attribute.attname || ':'
      || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':'
      || attribute.attnotnull::text
    ORDER BY attribute.attnum
  ) INTO actual_columns
  FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid = capability_table
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'capability_id:uuid:true',
    'target_schema:oid:true',
    'backend_pid:integer:true',
    'transaction_id:xid8:true'
  ]::text[] THEN
    RAISE EXCEPTION '0345 session tenancy inventory ledger column drift'
      USING ERRCODE = '55000', DETAIL = actual_columns::text;
  END IF;
  SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
  INTO primary_key_columns
  FROM pg_catalog.pg_constraint constraint_value
  CROSS JOIN LATERAL pg_catalog.unnest(constraint_value.conkey)
    WITH ORDINALITY key(attnum, ordinality)
  JOIN pg_catalog.pg_attribute attribute
    ON attribute.attrelid = constraint_value.conrelid
    AND attribute.attnum = key.attnum
  WHERE constraint_value.conrelid = capability_table
    AND constraint_value.contype = 'p';
  IF primary_key_columns IS DISTINCT FROM ARRAY['capability_id']::text[]
    OR (
      SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint constraint_value
      WHERE constraint_value.conrelid = capability_table
    ) <> 1
  THEN
    RAISE EXCEPTION '0345 session tenancy inventory ledger constraint drift'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) acl
    WHERE relation.oid = capability_table
      AND acl.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION '0345 session tenancy inventory ledger ACL drift'
      USING ERRCODE = '55000';
  END IF;
END
$session_tenancy_fence_inventory_contract$;

CREATE OR REPLACE FUNCTION
  opengeni_private.session_tenancy_fence_inventory_capability_active(
    p_target_schema oid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $inventory_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.session_tenancy_fence_inventory_capabilities capability
    WHERE capability.target_schema = p_target_schema
      AND capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$inventory_active$;

REVOKE ALL ON FUNCTION
  opengeni_private.session_tenancy_fence_inventory_capability_active(oid)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION
  opengeni_private.open_session_tenancy_fence_inventory(p_target_schema oid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $open_inventory$
DECLARE
  capability_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    JOIN opengeni_private.session_tenancy_fence_target_registry registry
      ON registry.target_schema = namespace.oid
      AND registry.singleton
    WHERE namespace.oid = p_target_schema
  ) THEN
    RAISE EXCEPTION 'session tenancy inventory target schema is not registered'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.session_tenancy_fence_inventory_capabilities (
    capability_id, target_schema, backend_pid, transaction_id
  ) VALUES (
    capability_id_value,
    p_target_schema,
    pg_catalog.pg_backend_pid(),
    pg_catalog.pg_current_xact_id()
  );
  RETURN capability_id_value;
END
$open_inventory$;

CREATE OR REPLACE FUNCTION
  opengeni_private.close_session_tenancy_fence_inventory(p_capability_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $close_inventory$
  DELETE FROM opengeni_private.session_tenancy_fence_inventory_capabilities
  WHERE capability_id = p_capability_id
    AND backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
$close_inventory$;

REVOKE ALL ON FUNCTION
  opengeni_private.open_session_tenancy_fence_inventory(oid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.close_session_tenancy_fence_inventory(uuid)
  FROM PUBLIC;

-- Inventory authority ends before a helper returns. The caller may still need
-- owner-side RLS access while it mutates the rows protected by the locks, so
-- that phase has a separate exact-token capability. It is opened only after
-- all affected workspace fences are held and is closed by the patched caller
-- on both success and exception.
CREATE TABLE IF NOT EXISTS opengeni_private.session_tenancy_fenced_access_capabilities (
  capability_id uuid PRIMARY KEY,
  target_schema oid NOT NULL,
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL
);

REVOKE ALL ON TABLE
  opengeni_private.session_tenancy_fenced_access_capabilities
  FROM PUBLIC;

DO $session_tenancy_fenced_access_contract$
DECLARE
  capability_table oid := pg_catalog.to_regclass(
    'opengeni_private.session_tenancy_fenced_access_capabilities'
  );
  actual_columns text[];
  primary_key_columns text[];
BEGIN
  IF capability_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid = capability_table
      AND relation.relkind = 'r'
      AND relation.relowner = current_user::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION '0345 session tenancy fenced-access ledger owner/type drift'
      USING ERRCODE = '55000';
  END IF;
  SELECT pg_catalog.array_agg(
    attribute.attname || ':'
      || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || ':'
      || attribute.attnotnull::text
    ORDER BY attribute.attnum
  ) INTO actual_columns
  FROM pg_catalog.pg_attribute attribute
  WHERE attribute.attrelid = capability_table
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF actual_columns IS DISTINCT FROM ARRAY[
    'capability_id:uuid:true',
    'target_schema:oid:true',
    'backend_pid:integer:true',
    'transaction_id:xid8:true'
  ]::text[] THEN
    RAISE EXCEPTION '0345 session tenancy fenced-access ledger column drift'
      USING ERRCODE = '55000', DETAIL = actual_columns::text;
  END IF;
  SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
  INTO primary_key_columns
  FROM pg_catalog.pg_constraint constraint_value
  CROSS JOIN LATERAL pg_catalog.unnest(constraint_value.conkey)
    WITH ORDINALITY key(attnum, ordinality)
  JOIN pg_catalog.pg_attribute attribute
    ON attribute.attrelid = constraint_value.conrelid
    AND attribute.attnum = key.attnum
  WHERE constraint_value.conrelid = capability_table
    AND constraint_value.contype = 'p';
  IF primary_key_columns IS DISTINCT FROM ARRAY['capability_id']::text[]
    OR (
      SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint constraint_value
      WHERE constraint_value.conrelid = capability_table
    ) <> 1
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) acl
      WHERE relation.oid = capability_table
        AND acl.grantee <> relation.relowner
    )
  THEN
    RAISE EXCEPTION '0345 session tenancy fenced-access ledger constraint/ACL drift'
      USING ERRCODE = '55000';
  END IF;
END
$session_tenancy_fenced_access_contract$;

CREATE OR REPLACE FUNCTION
  opengeni_private.open_session_tenancy_fenced_access(p_target_schema oid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $open_fenced_access$
DECLARE
  capability_id_value uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace
    JOIN opengeni_private.session_tenancy_fence_target_registry registry
      ON registry.target_schema = namespace.oid
      AND registry.singleton
    WHERE namespace.oid = p_target_schema
  ) THEN
    RAISE EXCEPTION 'session tenancy fenced-access target schema is not registered'
      USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.session_tenancy_fenced_access_capabilities (
    capability_id, target_schema, backend_pid, transaction_id
  ) VALUES (
    capability_id_value,
    p_target_schema,
    pg_catalog.pg_backend_pid(),
    pg_catalog.pg_current_xact_id()
  );
  RETURN capability_id_value;
END
$open_fenced_access$;

CREATE OR REPLACE FUNCTION
  opengeni_private.close_session_tenancy_fenced_access(p_capability_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $close_fenced_access$
  DELETE FROM opengeni_private.session_tenancy_fenced_access_capabilities
  WHERE capability_id = p_capability_id
    AND backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
$close_fenced_access$;

CREATE OR REPLACE FUNCTION
  opengeni_private.session_tenancy_fenced_access_capability_active(
    p_target_schema oid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $fenced_access_active$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.session_tenancy_fenced_access_capabilities capability
    WHERE capability.target_schema = p_target_schema
      AND capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$fenced_access_active$;

REVOKE ALL ON FUNCTION
  opengeni_private.open_session_tenancy_fenced_access(oid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.close_session_tenancy_fenced_access(uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION
  opengeni_private.session_tenancy_fenced_access_capability_active(oid)
  FROM PUBLIC;

-- CREATE OR REPLACE preserves a function's owner and direct role grants. Do
-- not let a pre-existing same-signature object silently retain mint/close or
-- capability-observation authority. All six shared seams must be owned only by
-- this migration owner and executable by no other role.
DO $session_tenancy_shared_capability_function_contract$
DECLARE
  signature text;
  routine oid;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'opengeni_private.session_tenancy_fence_inventory_capability_active(oid)',
    'opengeni_private.open_session_tenancy_fence_inventory(oid)',
    'opengeni_private.close_session_tenancy_fence_inventory(uuid)',
    'opengeni_private.session_tenancy_fenced_access_capability_active(oid)',
    'opengeni_private.open_session_tenancy_fenced_access(oid)',
    'opengeni_private.close_session_tenancy_fenced_access(uuid)'
  ] LOOP
    routine := pg_catalog.to_regprocedure(signature);
    IF routine IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc procedure
      WHERE procedure.oid = routine
        AND procedure.proowner = current_user::pg_catalog.regrole
        AND procedure.prosecdef
    ) THEN
      RAISE EXCEPTION
        '0345 shared session tenancy capability function owner/type drift: %',
        signature USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) acl
      WHERE procedure.oid = routine
        AND acl.grantee <> procedure.proowner
    ) THEN
      RAISE EXCEPTION
        '0345 shared session tenancy capability function ACL drift: %',
        signature USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$session_tenancy_shared_capability_function_contract$;

-- The target identity is a literal namespace OID captured by this migration,
-- not a search_path-, GUC-, or caller-controlled string. Each dedicated schema
-- owns a separate copy, so later target migrations cannot overwrite it.
DO $session_tenancy_fence_target_identity$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
BEGIN
  EXECUTE pg_catalog.format($identity$
    CREATE OR REPLACE FUNCTION %1$I.session_tenancy_fence_target_schema()
    RETURNS oid
    LANGUAGE sql
    IMMUTABLE
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $body$ SELECT %2$s::oid $body$;
    REVOKE ALL ON FUNCTION %1$I.session_tenancy_fence_target_schema() FROM PUBLIC;
  $identity$, target_schema, target_schema_oid);
END
$session_tenancy_fence_target_identity$;

CREATE OR REPLACE FUNCTION session_tenancy_fence_owner_policy_active(
  p_actor text,
  p_expected_owner text,
  p_target_schema oid,
  p_workspace_id uuid,
  p_inventory boolean
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $owner_policy$
DECLARE
  lock_key bigint;
BEGIN
  IF p_actor IS DISTINCT FROM p_expected_owner THEN
    RETURN false;
  END IF;
  IF p_inventory THEN
    RETURN opengeni_private.session_tenancy_fence_inventory_capability_active(
      p_target_schema
    );
  END IF;
  IF p_workspace_id IS NULL THEN
    RETURN false;
  END IF;
  IF NOT opengeni_private.session_tenancy_fenced_access_capability_active(
    p_target_schema
  ) THEN
    RETURN false;
  END IF;
  lock_key := pg_catalog.hashtextextended(
    'session-tenancy:' || p_workspace_id::text,
    0
  );
  RETURN EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks held
    WHERE held.locktype = 'advisory'
      AND held.pid = pg_catalog.pg_backend_pid()
      AND held.granted
      AND held.classid = (((lock_key >> 32) & 4294967295)::bigint)::oid
      AND held.objid = ((lock_key & 4294967295)::bigint)::oid
      AND held.objsubid = 1
      AND held.mode IN ('ShareLock', 'ExclusiveLock')
  );
END
$owner_policy$;

REVOKE ALL ON FUNCTION
  session_tenancy_fence_owner_policy_active(text, text, oid, uuid, boolean)
  FROM PUBLIC;
-- This predicate returns only a boolean derived from its arguments and the
-- current backend's private capability/lock state. Every runtime role must be
-- able to plan RLS expressions that reference it; authority-minting functions
-- and the ledger remain fully revoked.
GRANT EXECUTE ON FUNCTION
  session_tenancy_fence_owner_policy_active(text, text, oid, uuid, boolean)
  TO PUBLIC;

DO $session_tenancy_fence_owner_policies$
DECLARE
  target_schema text := pg_catalog.current_schema();
  target_schema_oid oid := pg_catalog.current_schema()::pg_catalog.regnamespace;
  migration_owner text := current_user;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sandbox_leases',
    'sandbox_lease_holders',
    'sandbox_retained_processes',
    'sessions'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fence_inventory_read ON %I.%I '
        || 'FOR SELECT USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, true))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'sandbox_leases',
    'sandbox_lease_holders',
    'sandbox_retained_processes'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fenced_owner_write ON %I.%I '
        || 'FOR ALL USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, false)) '
        || 'WITH CHECK ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, false))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY[
    'sandbox_workspace_mutation_admissions',
    'sessions',
    'session_turns',
    'session_turn_attempts',
    'session_background_commands'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY session_tenancy_fenced_owner_read ON %I.%I '
        || 'FOR SELECT USING ('
        || '%I.session_tenancy_fence_owner_policy_active('
        || 'current_user, %L, %s::oid, workspace_id, false))',
      target_schema,
      table_name,
      target_schema,
      migration_owner,
      target_schema_oid
    );
  END LOOP;

  -- `session_visibility_isolation` is RESTRICTIVE, so a permissive owner
  -- policy alone cannot expose private sessions to the bounded inventory or
  -- to a fenced definer. Admit only this exact owner+schema+xact capability or
  -- an already-held workspace fence, then retain the original subject rule.
  EXECUTE pg_catalog.format(
    'DROP POLICY IF EXISTS session_visibility_isolation ON %I.sessions',
    target_schema
  );
  EXECUTE pg_catalog.format(
    'CREATE POLICY session_visibility_isolation ON %1$I.sessions AS RESTRICTIVE '
      || 'FOR ALL USING ('
      || '%1$I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %2$L, %3$s::oid, workspace_id, true) '
      || 'OR %1$I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %2$L, %3$s::oid, workspace_id, false) '
      || 'OR nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), '''') '
      || 'IS NULL OR visibility = ''workspace_shared'' '
      || 'OR %1$I.session_private_actor_visible('
      || 'account_id, workspace_id, owner_organization_membership_id, owner_subject_id)'
      || ') WITH CHECK ('
      || '%1$I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %2$L, %3$s::oid, workspace_id, true) '
      || 'OR %1$I.session_tenancy_fence_owner_policy_active('
      || 'current_user, %2$L, %3$s::oid, workspace_id, false) '
      || 'OR nullif(pg_catalog.current_setting(''opengeni.subject_id'', true), '''') '
      || 'IS NULL OR visibility = ''workspace_shared'' '
      || 'OR %1$I.session_private_actor_visible('
      || 'account_id, workspace_id, owner_organization_membership_id, owner_subject_id)'
      || ')',
    target_schema,
    migration_owner,
    target_schema_oid
  );
END
$session_tenancy_fence_owner_policies$;

-- The lifecycle reaper is deliberately cross-workspace, but it still mutates
-- sandbox_lease_holders and therefore participates in the same quiescence
-- protocol. Acquire every currently active lease workspace in stable order
-- before the reaper locks any operation, lease, or holder row. These are
-- shared advisory locks: ordinary tenant writers continue concurrently, while
-- a fork/visibility transition waits only when its workspace has live holder
-- state that the global sweep may inspect or remove.
CREATE OR REPLACE FUNCTION acquire_sandbox_reaper_session_tenancy_fences()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $reaper_fences$
DECLARE
  inventory_capability_id uuid;
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
  inventory_capability_id :=
    opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
  FOR workspace_id_value IN
    SELECT DISTINCT lease.workspace_id
    FROM sandbox_leases lease
    WHERE lease.workspace_id IS NOT NULL
      AND (
        lease.liveness <> 'cold'
        OR EXISTS (
          SELECT 1 FROM sandbox_lease_holders holder
          WHERE holder.lease_id = lease.id
        )
      )
    ORDER BY lease.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RETURN locked_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RAISE;
END
$reaper_fences$;

REVOKE ALL ON FUNCTION
  acquire_sandbox_reaper_session_tenancy_fences()
  FROM PUBLIC;

-- Routine-local entry points must not depend on a TypeScript wrapper having
-- opened the fence. This single-workspace helper is intentionally private so
-- direct app-executable SECURITY-DEFINER calls can enter the same shared
-- protocol after validating their scope and before taking their first row
-- lock or mutating a fenced table.
CREATE OR REPLACE FUNCTION acquire_session_tenancy_fence(
  p_workspace_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $workspace_fence$
BEGIN
  IF p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'session-tenancy fence requires a workspace'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'session-tenancy:' || p_workspace_id::text,
      0
    )
  );
END
$workspace_fence$;

REVOKE ALL ON FUNCTION
  acquire_session_tenancy_fence(uuid)
  FROM PUBLIC;

-- Global retained-process claiming is bounded by p_limit at mutation time,
-- but SKIP LOCKED means the exact batch cannot be known safely before its row
-- locks. Fence every currently due workspace, and no other workspace, in UUID
-- order before the claim CTE starts taking those locks.
CREATE OR REPLACE FUNCTION
  acquire_due_retained_process_session_tenancy_fences()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $retained_process_fences$
DECLARE
  inventory_capability_id uuid;
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
  inventory_capability_id :=
    opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
  FOR workspace_id_value IN
    SELECT DISTINCT process.workspace_id
    FROM sandbox_retained_processes process
    WHERE process.workspace_id IS NOT NULL
      AND process.state = 'active'
      AND process.reconcile_after <= pg_catalog.now()
    ORDER BY process.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RETURN locked_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RAISE;
END
$retained_process_fences$;

REVOKE ALL ON FUNCTION
  acquire_due_retained_process_session_tenancy_fences()
  FROM PUBLIC;

-- Rotation deletes viewer holders only for due leases. Lock the distinct due
-- lease workspaces for that population, not every workspace with an unrelated
-- live lease.
CREATE OR REPLACE FUNCTION
  acquire_due_sandbox_rotation_session_tenancy_fences(
    p_lead_ms bigint
  )
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $rotation_fences$
DECLARE
  inventory_capability_id uuid;
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  PERFORM pg_catalog.set_config('opengeni.sandbox_recovery_protocol_v2', '1', true);
  inventory_capability_id :=
    opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
  FOR workspace_id_value IN
    SELECT DISTINCT lease.workspace_id
    FROM sandbox_leases lease
    WHERE lease.workspace_id IS NOT NULL
      AND lease.backend = 'modal'
      AND lease.liveness IN ('warming', 'warm')
      AND lease.provider_deadline_at IS NOT NULL
      AND lease.provider_deadline_at
        <= pg_catalog.now()
          + pg_catalog.make_interval(secs => p_lead_ms / 1000.0)
      AND lease.rotation_requested_at IS NULL
      AND (
        lease.reaper_hold_id IS NULL
        OR lease.reaper_hold_until <= pg_catalog.now()
      )
    ORDER BY lease.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RETURN locked_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RAISE;
END
$rotation_fences$;

REVOKE ALL ON FUNCTION
  acquire_due_sandbox_rotation_session_tenancy_fences(bigint)
  FROM PUBLIC;

-- One connected machine may back sessions in several workspaces. Discover
-- the exact update population without row locks, then acquire every workspace
-- fence in deterministic order after the detach routine opens its bounded
-- write capability but before it locks or mutates dependent-session state.
CREATE OR REPLACE FUNCTION
  acquire_scoped_machine_session_tenancy_fences(
    p_account_id uuid,
    p_sandbox_id uuid
  )
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $machine_fences$
DECLARE
  inventory_capability_id uuid;
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  IF p_account_id IS NULL OR p_sandbox_id IS NULL THEN
    RAISE EXCEPTION 'machine session-tenancy fences require complete scope'
      USING ERRCODE = '22023';
  END IF;
  inventory_capability_id :=
    opengeni_private.open_session_tenancy_fence_inventory(
      session_tenancy_fence_target_schema()
    );
  FOR workspace_id_value IN
    SELECT DISTINCT session.workspace_id
    FROM sessions session
    WHERE session.account_id = p_account_id
      AND (
        session.active_sandbox_id = p_sandbox_id
        OR (
          session.sandbox_group_id = p_sandbox_id
          AND session.sandbox_backend = 'selfhosted'
        )
      )
    ORDER BY session.workspace_id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RETURN locked_count;
EXCEPTION WHEN OTHERS THEN
  PERFORM opengeni_private.close_session_tenancy_fence_inventory(
    inventory_capability_id
  );
  RAISE;
END
$machine_fences$;

REVOKE ALL ON FUNCTION
  acquire_scoped_machine_session_tenancy_fences(uuid, uuid)
  FROM PUBLIC;

-- Both shipped global reapers are SECURITY-DEFINER routines that take row
-- locks internally. Inject the shared-fence entry at the start of their exact
-- frozen definitions so every call path, including a direct SQL invocation,
-- enters the protocol before those row locks. Refuse definition drift instead
-- of silently producing an unfenced partial repair.
DO $repair_global_sandbox_reapers$
DECLARE
  interaction_definition text;
  lease_definition text;
  interaction_prefix constant text :=
    E'      IF p_interaction_holder_ttl_ms <= 0 THEN\n'
    || E'        RETURN 0;\n'
    || E'      END IF;';
  lease_prefix constant text := E'    BEGIN\n      PERFORM pg_catalog.set_config(''opengeni.sandbox_recovery_protocol_v2'', ''1'', true);';
  fenced_prefix constant text :=
    E'      PERFORM acquire_sandbox_reaper_session_tenancy_fences();';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  ) INTO interaction_definition;
  IF pg_catalog.strpos(interaction_definition, interaction_prefix) = 0
    OR pg_catalog.strpos(
      pg_catalog.substr(
        interaction_definition,
        pg_catalog.strpos(interaction_definition, interaction_prefix)
          + pg_catalog.length(interaction_prefix)
      ),
      interaction_prefix
    ) > 0
  THEN
    RAISE EXCEPTION '0345 interaction reaper definition drift'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.replace(
    interaction_definition,
    interaction_prefix,
    interaction_prefix || E'\n\n' || fenced_prefix
  );

  SELECT pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'::regprocedure
  ) INTO lease_definition;
  IF pg_catalog.strpos(lease_definition, lease_prefix) = 0
    OR pg_catalog.strpos(
      pg_catalog.substr(
        lease_definition,
        pg_catalog.strpos(lease_definition, lease_prefix)
          + pg_catalog.length(lease_prefix)
      ),
      lease_prefix
    ) > 0
  THEN
    RAISE EXCEPTION '0345 lease reaper definition drift'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE pg_catalog.replace(
    lease_definition,
    lease_prefix,
    E'    BEGIN\n' || fenced_prefix || E'\n'
      || E'      PERFORM pg_catalog.set_config(''opengeni.sandbox_recovery_protocol_v2'', ''1'', true);'
  );
END
$repair_global_sandbox_reapers$;

-- The retained-process claim and provider-deadline rotation sweeps are also
-- global SECURITY-DEFINER mutators. Their TypeScript callers do not provide a
-- workspace scope, so repair the installed SQL definitions themselves with
-- population-specific, deterministically ordered fence helpers.
DO $repair_global_background_session_tenancy_fences$
DECLARE
  definition text;
  patched text;
  occurrences integer;
  protocol_prefix constant text :=
    E'      PERFORM pg_catalog.set_config(''opengeni.sandbox_recovery_protocol_v2'', ''1'', true);';
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)'
      ::regprocedure
  );
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, protocol_prefix, ''))
  ) / pg_catalog.length(protocol_prefix);
  IF occurrences <> 1
    OR pg_catalog.strpos(
      definition,
      'acquire_due_retained_process_session_tenancy_fences'
    ) > 0
  THEN
    RAISE EXCEPTION '0345 retained-process claim definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    definition,
    protocol_prefix,
    E'      PERFORM acquire_due_retained_process_session_tenancy_fences();\n\n'
      || protocol_prefix
  );
  EXECUTE patched;

  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.request_due_sandbox_rotations(bigint,integer)'
      ::regprocedure
  );
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, protocol_prefix, ''))
  ) / pg_catalog.length(protocol_prefix);
  IF occurrences <> 1
    OR pg_catalog.strpos(
      definition,
      'acquire_due_sandbox_rotation_session_tenancy_fences'
    ) > 0
  THEN
    RAISE EXCEPTION '0345 due sandbox rotation definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    definition,
    protocol_prefix,
    E'      PERFORM acquire_due_sandbox_rotation_session_tenancy_fences(\n'
      || E'        p_lead_ms\n'
      || E'      );\n\n'
      || protocol_prefix
  );
  EXECUTE patched;
END
$repair_global_background_session_tenancy_fences$;

-- Organization membership suspension/offboarding is account-wide: the
-- preparation seam and both layers of the command can inspect or mutate
-- session state in every workspace owned by the organization. Enter every
-- workspace's shared fence in stable order immediately after the existing
-- organization-membership advisory prefix and before any of those routines
-- take row locks. Keeping this in their SECURITY-DEFINER SQL path also covers
-- direct command invocations rather than relying on one TypeScript caller.
CREATE OR REPLACE FUNCTION
  acquire_organization_session_tenancy_fences(
    p_account_id uuid
  )
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $membership_fences$
DECLARE
  workspace_id_value uuid;
  locked_count integer := 0;
BEGIN
  IF p_account_id IS NULL THEN
    RAISE EXCEPTION 'organization session-tenancy fence requires an organization'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'organization-membership:' || p_account_id::text,
      0
    )
  );
  FOR workspace_id_value IN
    SELECT workspace.id
    FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
    ORDER BY workspace.id
  LOOP
    PERFORM acquire_session_tenancy_fence(workspace_id_value);
    locked_count := locked_count + 1;
  END LOOP;
  RETURN locked_count;
END
$membership_fences$;

REVOKE ALL ON FUNCTION
  acquire_organization_session_tenancy_fences(uuid)
  FROM PUBLIC;

-- Migration 0299 installed the organization advisory prefix in all three
-- lifecycle routines by exact definition repair. Extend that same prefix with
-- the workspace fences, again refusing any definition drift instead of
-- silently leaving one privileged mutation path outside the protocol.
DO $repair_organization_membership_session_tenancy_fences$
DECLARE
  signature text;
  definition text;
  patched text;
  occurrences integer;
  organization_prefix constant text :=
    E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n'
    || E'    ''organization-membership:'' || account_id_value::text, 0\n'
    || E'  ));';
  fenced_prefix constant text := organization_prefix
    || E'\n  PERFORM acquire_organization_session_tenancy_fences(\n'
    || E'    account_id_value\n'
    || E'  );';
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'prepare_organization_membership_protocol_settlements(jsonb)',
    'organization_membership_command_0263(jsonb)',
    'organization_membership_command(jsonb)'
  ] LOOP
    definition := pg_catalog.pg_get_functiondef(
      pg_catalog.to_regprocedure(
        pg_catalog.quote_ident(pg_catalog.current_schema()) || '.' || signature
      )
    );
    IF definition IS NULL THEN
      RAISE EXCEPTION
        '0345 organization membership lifecycle function % is missing', signature
        USING ERRCODE = '55000';
    END IF;
    occurrences := (
      pg_catalog.length(definition)
        - pg_catalog.length(
          pg_catalog.replace(definition, organization_prefix, '')
        )
    ) / pg_catalog.length(organization_prefix);
    IF occurrences <> 1
      OR pg_catalog.strpos(
        definition,
        'acquire_organization_session_tenancy_fences'
      ) > 0
    THEN
      RAISE EXCEPTION
        '0345 organization membership session-tenancy prefix drift for %',
        signature USING ERRCODE = '55000';
    END IF;
    patched := pg_catalog.replace(
      definition,
      organization_prefix,
      fenced_prefix
    );
    IF pg_catalog.strpos(patched, fenced_prefix) = 0
      OR pg_catalog.strpos(patched, organization_prefix)
        > pg_catalog.strpos(patched, fenced_prefix)
    THEN
      RAISE EXCEPTION
        '0345 organization membership session-tenancy repair failed for %',
        signature USING ERRCODE = '55000';
    END IF;
    EXECUTE patched;
  END LOOP;
END
$repair_organization_membership_session_tenancy_fences$;

DO $repair_organization_retention_session_tenancy_fence$
DECLARE
  definition text;
  patched text;
  occurrences integer;
  authority_prefix constant text :=
    E'  PERFORM opengeni_private.assert_organization_retention_account(p_account_id);';
  fenced_prefix constant text := authority_prefix
    || E'\n  PERFORM acquire_organization_session_tenancy_fences(\n'
    || E'    p_account_id\n'
    || E'  );';
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      pg_catalog.quote_ident(pg_catalog.current_schema())
        || '.finalize_organization_retention_deletion(uuid,uuid,uuid,text)'
    )
  );
  IF definition IS NULL THEN
    RAISE EXCEPTION '0345 organization retention finalizer is missing'
      USING ERRCODE = '55000';
  END IF;
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(
        pg_catalog.replace(definition, authority_prefix, '')
      )
  ) / pg_catalog.length(authority_prefix);
  IF occurrences <> 1
    OR pg_catalog.strpos(
      definition,
      'acquire_organization_session_tenancy_fences'
    ) > 0
  THEN
    RAISE EXCEPTION '0345 organization retention session-tenancy prefix drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(
    definition,
    authority_prefix,
    fenced_prefix
  );
  IF pg_catalog.strpos(patched, fenced_prefix) = 0 THEN
    RAISE EXCEPTION '0345 organization retention session-tenancy repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;
END
$repair_organization_retention_session_tenancy_fence$;

-- Finish the direct-call cutover for every app-executable SECURITY-DEFINER
-- routine that writes one of the fenced tables. Each repair anchors on one
-- exact frozen source fragment and aborts the migration on definition drift.
-- The fence is inside the routine, after authority/argument validation where
-- available, and before its first row lock or protected-table mutation.
DO $repair_app_mutator_session_tenancy_fences$
DECLARE
  definition text;
  patched text;
  occurrences integer;
  anchor text;
  replacement text;
  target regprocedure;
BEGIN
  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.backfill_organization_session_ownership(uuid,integer,boolean,text)'
  );
  definition := pg_catalog.pg_get_functiondef(target);
  anchor := E'  ledger_available := p_run_key IS NOT NULL';
  replacement :=
    E'  IF NOT p_dry_run THEN\n'
    || E'    PERFORM acquire_organization_session_tenancy_fences(\n'
    || E'      p_organization_id\n'
    || E'    );\n'
    || E'  END IF;\n\n'
    || anchor;
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF target IS NULL OR occurrences <> 1
    OR pg_catalog.strpos(
      definition,
      'acquire_organization_session_tenancy_fences'
    ) > 0
  THEN
    RAISE EXCEPTION '0345 session ownership backfill definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  EXECUTE patched;

  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.detach_scoped_machine_dependent_sessions(uuid,uuid,uuid)'
  );
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'  INSERT INTO opengeni_private.scoped_compute_capabilities(\n'
    || E'    backend_pid, transaction_id, capability_kind\n'
    || E'  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), ''write'')\n'
    || E'  ON CONFLICT DO NOTHING;';
  replacement :=
    anchor
    || E'\n  PERFORM acquire_scoped_machine_session_tenancy_fences(\n'
    || E'    p_account_id, p_sandbox_id\n'
    || E'  );';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF target IS NULL OR occurrences <> 1
    OR pg_catalog.strpos(
      definition,
      'acquire_scoped_machine_session_tenancy_fences'
    ) > 0
  THEN
    RAISE EXCEPTION '0345 scoped machine detach definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  EXECUTE patched;

  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.accept_turn_personal_resource_attachment(uuid,uuid,uuid,uuid,text,integer,boolean,integer)'
  );
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'    RAISE EXCEPTION ''session tenancy product is not activated'' USING ERRCODE = ''42501'';\n'
    || E'  END IF;';
  replacement :=
    anchor
    || E'\n\n  PERFORM acquire_session_tenancy_fence(p_workspace_id);';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF target IS NULL OR occurrences <> 1
    OR pg_catalog.strpos(definition, 'acquire_session_tenancy_fence') > 0
  THEN
    RAISE EXCEPTION '0345 accepted-turn attachment definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  EXECUTE patched;

  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.materialize_scheduled_task_reusable_session_from_run('
      || 'uuid,uuid,uuid,uuid,uuid,bigint,text)'
  );
  definition := pg_catalog.pg_get_functiondef(target);
  anchor :=
    E'  IF p_source_revision <= 0 OR p_source_digest !~ ''^[0-9a-f]{64}$'' THEN';
  replacement :=
    E'  PERFORM acquire_session_tenancy_fence(p_workspace_id);\n\n'
    || anchor;
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF target IS NULL OR occurrences <> 1
    OR pg_catalog.strpos(definition, 'acquire_session_tenancy_fence') > 0
  THEN
    RAISE EXCEPTION '0345 scheduled reusable-session materializer definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  EXECUTE patched;

  target := pg_catalog.to_regprocedure(
    pg_catalog.quote_ident(pg_catalog.current_schema())
      || '.workspace_membership_removal_command(jsonb)'
  );
  definition := pg_catalog.pg_get_functiondef(target);
  anchor := E'  input_hash_value := pg_catalog.encode(';
  replacement :=
    E'  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(\n'
    || E'    ''organization-membership:'' || account_id_value::text, 0\n'
    || E'  ));\n'
    || E'  PERFORM acquire_session_tenancy_fence(workspace_id_value);\n\n'
    || anchor;
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF target IS NULL OR occurrences <> 1
    OR pg_catalog.strpos(definition, 'acquire_session_tenancy_fence') > 0
  THEN
    RAISE EXCEPTION '0345 workspace membership removal definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  EXECUTE patched;
END
$repair_app_mutator_session_tenancy_fences$;

-- A held advisory lock is necessary but not sufficient for the owner-only RLS
-- branch. These five routines are the paths that need owner access after their
-- bounded inventory helper returns. Give each invocation its own fenced-access
-- token after the locks are acquired, and delete that exact token on every
-- normal or exceptional exit. Refuse all frozen-definition drift.
DO $repair_owner_fenced_access_scopes$
DECLARE
  definition text;
  patched text;
  anchor text;
  replacement text;
  tail_anchor text;
  tail_replacement text;
  before_tail text;
  occurrences integer;
BEGIN
  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_stale_interaction_transitions(bigint)'::regprocedure
  );
  anchor := E'      settled_count integer := 0;';
  replacement := anchor || E'\n      fenced_access_capability_id uuid;';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1
    OR pg_catalog.strpos(definition, 'fenced_access_capability_id') > 0
  THEN
    RAISE EXCEPTION '0345 interaction reaper fenced-access definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  anchor := E'      PERFORM acquire_sandbox_reaper_session_tenancy_fences();';
  replacement := anchor
    || E'\n      fenced_access_capability_id :='
    || E'\n        opengeni_private.open_session_tenancy_fenced_access('
    || E'\n          session_tenancy_fence_target_schema()'
    || E'\n        );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 interaction reaper fenced-access open anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor := E'      RETURN settled_count;';
  replacement :=
    E'      PERFORM opengeni_private.close_session_tenancy_fenced_access('
    || E'\n        fenced_access_capability_id'
    || E'\n      );\n'
    || anchor;
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 interaction reaper fenced-access normal-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  tail_anchor := E'    END;\n    $function$\n';
  tail_replacement :=
    E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
      || E'        fenced_access_capability_id\n'
      || E'      );\n'
      || E'      RAISE;\n'
      || E'    END;\n'
      || E'    $function$\n';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, tail_anchor, ''))
  ) / pg_catalog.length(tail_anchor);
  IF occurrences <> 1
    OR pg_catalog.right(patched, pg_catalog.length(tail_anchor))
      IS DISTINCT FROM tail_anchor
  THEN
    RAISE EXCEPTION '0345 interaction reaper fenced-access tail drift'
      USING ERRCODE = '55000';
  END IF;
  before_tail := patched;
  patched := pg_catalog.regexp_replace(
    patched,
    E'    END;\\n    \\$function\\$\\n$',
    tail_replacement
  );
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(
          patched,
          'close_session_tenancy_fenced_access',
          ''
        ))
  ) / pg_catalog.length('close_session_tenancy_fenced_access');
  IF patched IS NOT DISTINCT FROM before_tail
    OR pg_catalog.right(patched, pg_catalog.length(tail_replacement))
      IS DISTINCT FROM tail_replacement
    OR pg_catalog.strpos(patched, 'fenced_access_capability_id uuid;') = 0
    OR pg_catalog.strpos(patched, 'open_session_tenancy_fenced_access') = 0
    OR occurrences <> 2
  THEN
    RAISE EXCEPTION '0345 interaction reaper fenced-access repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;

  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint)'
      ::regprocedure
  );
  anchor := E'    DECLARE\n      locked_ids uuid[];';
  replacement := E'    DECLARE\n      fenced_access_capability_id uuid;\n'
    || E'      locked_ids uuid[];';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1
    OR pg_catalog.strpos(definition, 'fenced_access_capability_id') > 0
  THEN
    RAISE EXCEPTION '0345 lease reaper fenced-access definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  anchor := E'      PERFORM acquire_sandbox_reaper_session_tenancy_fences();';
  replacement := anchor
    || E'\n      fenced_access_capability_id :='
    || E'\n        opengeni_private.open_session_tenancy_fenced_access('
    || E'\n          session_tenancy_fence_target_schema()'
    || E'\n        );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 lease reaper fenced-access open anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor :=
    E'      IF pg_catalog.cardinality(locked_ids) = 0 THEN\n'
    || E'        RETURN;\n'
    || E'      END IF;';
  replacement :=
    E'      IF pg_catalog.cardinality(locked_ids) = 0 THEN\n'
    || E'        PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
    || E'          fenced_access_capability_id\n'
    || E'        );\n'
    || E'        RETURN;\n'
    || E'      END IF;';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 lease reaper fenced-access early-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  tail_anchor := E'    END;\n    $function$\n';
  tail_replacement :=
    E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
      || E'        fenced_access_capability_id\n'
      || E'      );\n'
      || E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
      || E'        fenced_access_capability_id\n'
      || E'      );\n'
      || E'      RAISE;\n'
      || E'    END;\n'
      || E'    $function$\n';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, tail_anchor, ''))
  ) / pg_catalog.length(tail_anchor);
  IF occurrences <> 1
    OR pg_catalog.right(patched, pg_catalog.length(tail_anchor))
      IS DISTINCT FROM tail_anchor
  THEN
    RAISE EXCEPTION '0345 lease reaper fenced-access tail drift'
      USING ERRCODE = '55000';
  END IF;
  before_tail := patched;
  patched := pg_catalog.regexp_replace(
    patched,
    E'    END;\\n    \\$function\\$\\n$',
    tail_replacement
  );
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(
          patched,
          'close_session_tenancy_fenced_access',
          ''
        ))
  ) / pg_catalog.length('close_session_tenancy_fenced_access');
  IF patched IS NOT DISTINCT FROM before_tail
    OR pg_catalog.right(patched, pg_catalog.length(tail_replacement))
      IS DISTINCT FROM tail_replacement
    OR pg_catalog.strpos(patched, 'fenced_access_capability_id uuid;') = 0
    OR pg_catalog.strpos(patched, 'open_session_tenancy_fenced_access') = 0
    OR occurrences <> 3
  THEN
    RAISE EXCEPTION '0345 lease reaper fenced-access repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;

  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.request_due_sandbox_rotations(bigint,integer)'
      ::regprocedure
  );
  anchor := E'    DECLARE\n      requested integer;';
  replacement := E'    DECLARE\n      fenced_access_capability_id uuid;\n'
    || E'      requested integer;';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1
    OR pg_catalog.strpos(definition, 'fenced_access_capability_id') > 0
  THEN
    RAISE EXCEPTION '0345 rotation fenced-access definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  anchor :=
    E'      PERFORM acquire_due_sandbox_rotation_session_tenancy_fences(\n'
    || E'        p_lead_ms\n'
    || E'      );';
  replacement := anchor
    || E'\n      fenced_access_capability_id :='
    || E'\n        opengeni_private.open_session_tenancy_fenced_access('
    || E'\n          session_tenancy_fence_target_schema()'
    || E'\n        );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 rotation fenced-access open anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor := E'      RETURN requested;';
  replacement :=
    E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
    || E'        fenced_access_capability_id\n'
    || E'      );\n'
    || anchor;
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 rotation fenced-access normal-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  tail_anchor := E'    END;\n    $function$\n';
  tail_replacement :=
    E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
      || E'        fenced_access_capability_id\n'
      || E'      );\n'
      || E'      RAISE;\n'
      || E'    END;\n'
      || E'    $function$\n';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, tail_anchor, ''))
  ) / pg_catalog.length(tail_anchor);
  IF occurrences <> 1
    OR pg_catalog.right(patched, pg_catalog.length(tail_anchor))
      IS DISTINCT FROM tail_anchor
  THEN
    RAISE EXCEPTION '0345 rotation fenced-access tail drift'
      USING ERRCODE = '55000';
  END IF;
  before_tail := patched;
  patched := pg_catalog.regexp_replace(
    patched,
    E'    END;\\n    \\$function\\$\\n$',
    tail_replacement
  );
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(
          patched,
          'close_session_tenancy_fenced_access',
          ''
        ))
  ) / pg_catalog.length('close_session_tenancy_fenced_access');
  IF patched IS NOT DISTINCT FROM before_tail
    OR pg_catalog.right(patched, pg_catalog.length(tail_replacement))
      IS DISTINCT FROM tail_replacement
    OR pg_catalog.strpos(patched, 'fenced_access_capability_id uuid;') = 0
    OR pg_catalog.strpos(patched, 'open_session_tenancy_fenced_access') = 0
    OR occurrences <> 2
  THEN
    RAISE EXCEPTION '0345 rotation fenced-access repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;

  definition := pg_catalog.pg_get_functiondef(
    'opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint)'
      ::regprocedure
  );
  anchor := E'    BEGIN\n      IF p_limit < 1 OR p_limit > 100 THEN';
  replacement :=
    E'    DECLARE\n'
    || E'      fenced_access_capability_id uuid;\n'
    || E'    BEGIN\n'
    || E'      IF p_limit < 1 OR p_limit > 100 THEN';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1
    OR pg_catalog.strpos(definition, 'fenced_access_capability_id') > 0
  THEN
    RAISE EXCEPTION '0345 retained-process fenced-access definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  anchor := E'      PERFORM acquire_due_retained_process_session_tenancy_fences();';
  replacement := anchor
    || E'\n      fenced_access_capability_id :='
    || E'\n        opengeni_private.open_session_tenancy_fenced_access('
    || E'\n          session_tenancy_fence_target_schema()'
    || E'\n        );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 retained-process fenced-access open anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor := E'      SET CONSTRAINTS '
    || pg_catalog.quote_ident(pg_catalog.current_schema())
    || E'.sandbox_retained_processes_identity_v2 DEFERRED;';
  replacement := anchor
    || E'\n      PERFORM opengeni_private.close_session_tenancy_fenced_access('
    || E'\n        fenced_access_capability_id'
    || E'\n      );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 retained-process fenced-access normal-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  tail_anchor := E'    END;\n    $function$\n';
  tail_replacement :=
    E'    EXCEPTION WHEN OTHERS THEN\n'
      || E'      PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
      || E'        fenced_access_capability_id\n'
      || E'      );\n'
      || E'      RAISE;\n'
      || E'    END;\n'
      || E'    $function$\n';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, tail_anchor, ''))
  ) / pg_catalog.length(tail_anchor);
  IF occurrences <> 1
    OR pg_catalog.right(patched, pg_catalog.length(tail_anchor))
      IS DISTINCT FROM tail_anchor
  THEN
    RAISE EXCEPTION '0345 retained-process fenced-access tail drift'
      USING ERRCODE = '55000';
  END IF;
  before_tail := patched;
  patched := pg_catalog.regexp_replace(
    patched,
    E'    END;\\n    \\$function\\$\\n$',
    tail_replacement
  );
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(
          patched,
          'close_session_tenancy_fenced_access',
          ''
        ))
  ) / pg_catalog.length('close_session_tenancy_fenced_access');
  IF patched IS NOT DISTINCT FROM before_tail
    OR pg_catalog.right(patched, pg_catalog.length(tail_replacement))
      IS DISTINCT FROM tail_replacement
    OR pg_catalog.strpos(patched, 'fenced_access_capability_id uuid;') = 0
    OR pg_catalog.strpos(patched, 'open_session_tenancy_fenced_access') = 0
    OR occurrences <> 2
  THEN
    RAISE EXCEPTION '0345 retained-process fenced-access repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;

  definition := pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      pg_catalog.quote_ident(pg_catalog.current_schema())
        || '.detach_scoped_machine_dependent_sessions(uuid,uuid,uuid)'
    )
  );
  anchor := E'DECLARE\n  dependent_workspace_id uuid;';
  replacement := E'DECLARE\n  fenced_access_capability_id uuid;\n'
    || E'  dependent_workspace_id uuid;';
  occurrences := (
    pg_catalog.length(definition)
      - pg_catalog.length(pg_catalog.replace(definition, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1
    OR pg_catalog.strpos(definition, 'fenced_access_capability_id') > 0
  THEN
    RAISE EXCEPTION '0345 machine detach fenced-access definition drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(definition, anchor, replacement);
  anchor :=
    E'  PERFORM acquire_scoped_machine_session_tenancy_fences(\n'
    || E'    p_account_id, p_sandbox_id\n'
    || E'  );';
  replacement := anchor
    || E'\n  fenced_access_capability_id :='
    || E'\n    opengeni_private.open_session_tenancy_fenced_access('
    || E'\n      session_tenancy_fence_target_schema()'
    || E'\n    );';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 machine detach fenced-access open anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor :=
    E'  PERFORM pg_catalog.set_config(\n'
    || E'    ''opengeni.session_activity_gate_workspace_id'', '
    || E'p_origin_workspace_id::text, true\n'
    || E'  );\n'
    || E'  DELETE FROM opengeni_private.scoped_compute_capabilities\n'
    || E'  WHERE backend_pid = pg_catalog.pg_backend_pid()';
  replacement :=
    E'  PERFORM pg_catalog.set_config(\n'
    || E'    ''opengeni.session_activity_gate_workspace_id'', '
    || E'p_origin_workspace_id::text, true\n'
    || E'  );\n'
    || E'  PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
    || E'    fenced_access_capability_id\n'
    || E'  );\n'
    || E'  DELETE FROM opengeni_private.scoped_compute_capabilities\n'
    || E'  WHERE backend_pid = pg_catalog.pg_backend_pid()';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 machine detach fenced-access normal-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  anchor :=
    E'EXCEPTION WHEN OTHERS THEN\n'
    || E'  DELETE FROM opengeni_private.scoped_compute_capabilities\n'
    || E'  WHERE backend_pid = pg_catalog.pg_backend_pid()';
  replacement :=
    E'EXCEPTION WHEN OTHERS THEN\n'
    || E'  PERFORM opengeni_private.close_session_tenancy_fenced_access(\n'
    || E'    fenced_access_capability_id\n'
    || E'  );\n'
    || E'  DELETE FROM opengeni_private.scoped_compute_capabilities\n'
    || E'  WHERE backend_pid = pg_catalog.pg_backend_pid()';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, anchor, ''))
  ) / pg_catalog.length(anchor);
  IF occurrences <> 1 THEN
    RAISE EXCEPTION '0345 machine detach fenced-access exception-close anchor drift'
      USING ERRCODE = '55000';
  END IF;
  patched := pg_catalog.replace(patched, anchor, replacement);
  tail_anchor := E'  RAISE;\nEND\n$function$\n';
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(patched, tail_anchor, ''))
  ) / pg_catalog.length(tail_anchor);
  IF occurrences <> 1
    OR pg_catalog.right(patched, pg_catalog.length(tail_anchor))
      IS DISTINCT FROM tail_anchor
  THEN
    RAISE EXCEPTION '0345 machine detach fenced-access tail drift'
      USING ERRCODE = '55000';
  END IF;
  occurrences := (
    pg_catalog.length(patched)
      - pg_catalog.length(pg_catalog.replace(
          patched,
          'close_session_tenancy_fenced_access',
          ''
        ))
  ) / pg_catalog.length('close_session_tenancy_fenced_access');
  IF pg_catalog.strpos(patched, 'fenced_access_capability_id uuid;') = 0
    OR pg_catalog.strpos(patched, 'open_session_tenancy_fenced_access') = 0
    OR occurrences <> 2
  THEN
    RAISE EXCEPTION '0345 machine detach fenced-access repair failed'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE patched;
END
$repair_owner_fenced_access_scopes$;

DO $install_session_tenancy_fences$
DECLARE
  table_name text;
  hot_tables constant text[] := ARRAY[
    'sessions', 'session_turns', 'session_turn_attempts',
    'session_attempt_interruptions', 'session_system_updates',
    'session_human_input_requests', 'session_pending_tool_calls', 'agent_run_states',
    'session_goals', 'codex_capacity_waiters', 'xai_capacity_waiters',
    'session_realtime_modes', 'session_realtime_connections', 'scheduled_tasks',
    'sandbox_workspace_mutation_admissions', 'sandbox_retained_processes',
    'sandbox_lease_holders'
  ];
BEGIN
  FOREACH table_name IN ARRAY hot_tables LOOP
    EXECUTE format(
      'CREATE TRIGGER session_tenancy_workspace_fence '
      || 'BEFORE INSERT OR UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION opengeni_private.require_session_tenancy_fence()',
      table_name
    );
  END LOOP;
END
$install_session_tenancy_fences$;

CREATE OR REPLACE FUNCTION assert_session_tenancy_quiescent(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_require_singleton_group boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  session_group_id uuid;
  previous_subject text := current_setting('opengeni.subject_id', true);
  blocker text;
BEGIN

  SELECT sandbox_group_id INTO session_group_id FROM sessions
  WHERE account_id = p_account_id AND workspace_id = p_workspace_id
    AND id = p_session_id;

  IF EXISTS (SELECT 1 FROM session_turns WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND status IN ('queued','running','requires_action','recovering','waiting_capacity'))
  THEN blocker := 'nonterminal_turn';
  ELSIF EXISTS (SELECT 1 FROM session_turn_attempts WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state <> 'closed')
  THEN blocker := 'nonterminal_attempt';
  ELSIF EXISTS (SELECT 1 FROM session_attempt_interruptions WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state IN ('pending','delivered','acknowledged'))
  THEN blocker := 'unsettled_interruption';
  ELSIF EXISTS (SELECT 1 FROM session_system_updates WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = 'pending')
  THEN blocker := 'pending_system_update';
  ELSIF EXISTS (SELECT 1 FROM session_human_input_requests WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'pending')
  THEN blocker := 'pending_human_input';
  ELSIF EXISTS (SELECT 1 FROM session_pending_tool_calls WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id)
  THEN blocker := 'pending_tool_receipt';
  ELSIF EXISTS (SELECT 1 FROM agent_run_states WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id)
  THEN blocker := 'run_state';
  ELSIF EXISTS (SELECT 1 FROM session_goals WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'active')
  THEN blocker := 'active_goal';
  ELSIF EXISTS (SELECT 1 FROM codex_capacity_waiters WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'waiting')
    OR EXISTS (SELECT 1 FROM xai_capacity_waiters WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND status = 'waiting')
  THEN blocker := 'capacity_waiter';
  ELSIF EXISTS (SELECT 1 FROM session_realtime_modes WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id AND state = 'active')
    OR EXISTS (SELECT 1 FROM session_realtime_connections WHERE workspace_id = p_workspace_id
      AND session_id = p_session_id
      AND state IN ('negotiating','ready','active'))
  THEN blocker := 'active_realtime';
  ELSIF EXISTS (SELECT 1 FROM scheduled_tasks WHERE workspace_id = p_workspace_id
      AND reusable_session_id = p_session_id AND status = 'active')
  THEN blocker := 'active_scheduled_task';
  ELSIF EXISTS (SELECT 1 FROM sandbox_workspace_mutation_admissions
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND settled_at IS NULL)
  THEN blocker := 'workspace_mutation_admission';
  ELSIF EXISTS (SELECT 1 FROM sandbox_retained_processes
      WHERE workspace_id = p_workspace_id AND session_id = p_session_id
        AND state = 'active')
  THEN blocker := 'retained_process';
  ELSIF EXISTS (
      SELECT 1 FROM sandbox_lease_holders holder
      JOIN sandbox_leases lease ON lease.id = holder.lease_id
      WHERE lease.workspace_id = p_workspace_id
        AND lease.sandbox_group_id = session_group_id
        AND holder.kind IN ('viewer', 'interaction')
    )
  THEN blocker := 'active_sandbox_access';
  END IF;

  IF blocker IS NULL AND p_require_singleton_group THEN
    -- The caller's own actor-scoped RLS must not hide a sibling. The function
    -- has already locked and identified the authorized source session.
    PERFORM set_config('opengeni.subject_id', '', true);
    IF EXISTS (SELECT 1 FROM sessions sibling
      WHERE sibling.account_id = p_account_id
        AND sibling.workspace_id = p_workspace_id
        AND sibling.sandbox_group_id = session_group_id
        AND sibling.id <> p_session_id)
    THEN blocker := 'shared_sandbox_group'; END IF;
    PERFORM set_config(
      'opengeni.subject_id', CASE WHEN previous_subject IS NULL THEN '' ELSE previous_subject END, true
    );
  END IF;

  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'session tenancy mutation requires a quiescent session'
      USING ERRCODE = '55P03', DETAIL = blocker;
  END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config(
    'opengeni.subject_id', CASE WHEN previous_subject IS NULL THEN '' ELSE previous_subject END, true
  );
  RAISE;
END
$$;

CREATE OR REPLACE FUNCTION transition_session_visibility(
  p_account_id uuid,
  p_workspace_id uuid,
  p_session_id uuid,
  p_actor_subject_id text,
  p_target_visibility text,
  p_expected_authority_epoch integer,
  p_operation_key text,
  p_canonical_request_hash text,
  p_activation_version integer
) RETURNS TABLE (
  operation_id uuid,
  event_id uuid,
  event_sequence integer,
  visibility text,
  authority_epoch integer,
  owner_organization_membership_id uuid,
  changed boolean,
  replay boolean,
  interrupted_attempt_count integer,
  cancelled_turn_count integer,
  cancelled_update_count integer,
  paused_goal_count integer,
  revoked_grant_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  actor_membership organization_memberships%ROWTYPE;
  session_row sessions%ROWTYPE;
  receipt_row session_command_receipts%ROWTYPE;
  new_epoch integer;
  grant_count integer := 0;
  event_row_id uuid;
  event_row_sequence integer;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_session_id IS NULL
    OR p_actor_subject_id IS NULL OR p_target_visibility IS NULL
    OR p_expected_authority_epoch IS NULL OR p_operation_key IS NULL
    OR p_canonical_request_hash IS NULL OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session visibility transition requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session visibility transition authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_target_visibility NOT IN ('user_private', 'workspace_shared')
    OR p_expected_authority_epoch < 1
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session visibility transition request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  -- Match the canonical organization-membership lifecycle prefix before any
  -- table/row lock. This keeps visibility changes from reintroducing the
  -- workspace/account lock cycle repaired by migration 0299.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_workspace_id::text, 0
  ));


  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  PERFORM 1 FROM workspaces workspace_row
  WHERE workspace_row.id = p_workspace_id AND workspace_row.account_id = p_account_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session visibility transition requires active membership'
    USING ERRCODE = '42501'; END IF;

  SELECT session.* INTO session_row FROM sessions session
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  IF session_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR session_row.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  THEN RAISE EXCEPTION 'session visibility transition is owner-only'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_workspace_id, 'human', p_actor_subject_id,
    'session.visibility.change', p_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.workspace_id = p_workspace_id AND receipt.actor_type = 'human'
    AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL
    AND receipt.action = 'session.visibility.change'
    AND receipt.target_session_id = p_session_id AND receipt.target_turn_id IS NULL
    AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session visibility transition idempotency conflict'
      USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := nullif(receipt_row.result ->> 'eventSequence', '')::integer;
    visibility := receipt_row.result ->> 'visibility';
    authority_epoch := (receipt_row.result ->> 'authorityEpoch')::integer;
    owner_organization_membership_id := actor_membership.id;
    changed := (receipt_row.result ->> 'changed')::boolean;
    replay := true;
    interrupted_attempt_count := 0; cancelled_turn_count := 0;
    cancelled_update_count := 0; paused_goal_count := 0;
    revoked_grant_count := (receipt_row.result ->> 'revokedGrantCount')::integer;
    RETURN NEXT; RETURN;
  END IF;
  IF session_row.authority_epoch <> p_expected_authority_epoch THEN
    RAISE EXCEPTION 'session visibility transition authority epoch conflict'
      USING ERRCODE = '40001';
  END IF;

  new_epoch := session_row.authority_epoch;
  IF session_row.visibility <> p_target_visibility THEN
    PERFORM assert_session_tenancy_quiescent(
      p_account_id, p_workspace_id, p_session_id, p_target_visibility = 'user_private'
    );
    new_epoch := session_row.authority_epoch + 1;
    IF new_epoch < 2 THEN RAISE EXCEPTION 'session authority epoch exhausted'
      USING ERRCODE = '22003'; END IF;

    UPDATE organization_user_resource_grants grant_row
    SET status = 'revoked', revoked_at = clock_timestamp(),
      generation = grant_row.generation + 1, updated_at = clock_timestamp()
    WHERE grant_row.account_id = p_account_id
      AND grant_row.workspace_id = p_workspace_id
      AND grant_row.session_id = p_session_id
      AND grant_row.authority_epoch = session_row.authority_epoch
      AND grant_row.status = 'active';
    GET DIAGNOSTICS grant_count = ROW_COUNT;

    INSERT INTO session_visibility_write_capabilities (
      backend_pid, transaction_id, capability_id
    ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
    PERFORM set_config('opengeni.session_visibility_write_capability',
      visibility_write_capability_id::text, true);
    UPDATE sessions transition_target SET
      visibility = p_target_visibility,
      authority_epoch = new_epoch,
      initial_personal_connection_delegations = '[]'::jsonb,
      last_sequence = session_row.last_sequence + 1,
      updated_at = clock_timestamp()
    WHERE transition_target.id = p_session_id
      AND transition_target.authority_epoch = session_row.authority_epoch;
    IF NOT FOUND THEN RAISE EXCEPTION 'session visibility transition lost authority epoch CAS'
      USING ERRCODE = '40001'; END IF;

    INSERT INTO session_events (
      account_id, workspace_id, session_id, sequence, type, payload, occurred_at
    ) VALUES (
      p_account_id, p_workspace_id, p_session_id, session_row.last_sequence + 1,
      'session.visibility.changed',
      jsonb_build_object(
        'operationId', receipt_row.id,
        'fromVisibility', CASE session_row.visibility WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
        'toVisibility', CASE p_target_visibility WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
        'previousAuthorityEpoch', session_row.authority_epoch,
        'authorityEpoch', new_epoch,
        'interruptedAttemptCount', 0, 'cancelledTurnCount', 0,
        'cancelledUpdateCount', 0, 'pausedGoalCount', 0,
        'revokedGrantCount', grant_count
      ), clock_timestamp()
    ) RETURNING id, sequence INTO event_row_id, event_row_sequence;
    DELETE FROM session_visibility_write_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id()
      AND capability.capability_id = visibility_write_capability_id;
    PERFORM set_config('opengeni.session_visibility_write_capability',
      CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
      true);
  END IF;

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id,
    'eventSequence', event_row_sequence, 'visibility', p_target_visibility,
    'authorityEpoch', new_epoch, 'changed', session_row.visibility <> p_target_visibility,
    'revokedGrantCount', grant_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id;
  event_sequence := event_row_sequence; visibility := p_target_visibility;
  authority_epoch := new_epoch;
  owner_organization_membership_id := actor_membership.id;
  changed := session_row.visibility <> p_target_visibility; replay := false;
  interrupted_attempt_count := 0; cancelled_turn_count := 0;
  cancelled_update_count := 0; paused_goal_count := 0;
  revoked_grant_count := grant_count;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$$;

CREATE OR REPLACE FUNCTION fork_session_content(
  p_account_id uuid,
  p_source_workspace_id uuid,
  p_source_session_id uuid,
  p_actor_subject_id text,
  p_destination_workspace_id uuid,
  p_destination_visibility text,
  p_workspace_shared_acknowledged boolean,
  p_operation_key text,
  p_canonical_request_hash text,
  p_activation_version integer
) RETURNS TABLE (
  operation_id uuid,
  event_id uuid,
  event_sequence integer,
  session_id uuid,
  workspace_id uuid,
  visibility text,
  authority_epoch integer,
  copied_history_item_count integer,
  replay boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $$
DECLARE
  actor_membership organization_memberships%ROWTYPE;
  source_session sessions%ROWTYPE;
  destination_workspace workspaces%ROWTYPE;
  receipt_row session_command_receipts%ROWTYPE;
  destination_session_id uuid;
  history_count integer := 0;
  destination_activity_revision bigint;
  destination_depth integer;
  destination_depth_source text;
  destination_resources jsonb := '[]'::jsonb;
  event_row_id uuid;
  public_destination_visibility text;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_gate_state text := current_setting('opengeni.session_activity_gate_state', true);
  previous_gate_workspace text := current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
BEGIN
  IF p_account_id IS NULL OR p_source_workspace_id IS NULL
    OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
    OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
    OR p_workspace_shared_acknowledged IS NULL
    OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
    OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session fork requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session fork authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_destination_workspace_id IS DISTINCT FROM p_source_workspace_id
    OR p_destination_visibility NOT IN ('user_private', 'workspace_shared')
    OR (p_destination_visibility = 'user_private' AND p_workspace_shared_acknowledged)
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session fork request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF nullif(previous_gate_state, '') IS NOT NULL
    OR nullif(previous_gate_workspace, '') IS NOT NULL
  THEN RAISE EXCEPTION 'session fork requires ownership of the activity gate'
    USING ERRCODE = '55000'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_source_workspace_id::text, 0
  ));

  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  SELECT * INTO destination_workspace FROM workspaces workspace_row
  WHERE workspace_row.account_id = p_account_id
    AND workspace_row.id = p_source_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_source_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_source_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session fork requires active workspace authority'
    USING ERRCODE = '42501'; END IF;

  -- Resolve an already-applied receipt before inspecting mutable source state.
  -- The same still-authorized workspace actor can therefore recover the exact
  -- destination after a lost response even if the source owner later makes the
  -- source private. A new key still reaches the current source authorization
  -- check below and is denied.
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
    AND receipt.result ->> 'status' = 'applied';
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- Product decision, distinct from authority, and the same one migration 0323
  -- makes on the create path: a private destination inside a shared workspace
  -- requires the organization's private-session setting. A personal workspace
  -- is exempt exactly as it is there. This is deliberately placed after the
  -- keyed replay above and before any source read, so a fork that already
  -- committed still replays byte-identically after an owner disables the
  -- setting, while a fresh key fails closed with the same SQLSTATE the create
  -- path raises.
  IF p_destination_visibility = 'user_private'
    AND actor_membership.personal_workspace_id IS DISTINCT FROM p_source_workspace_id
    AND NOT organization_private_sessions_enabled(p_account_id)
  THEN
    RAISE EXCEPTION
      'private sessions are not enabled for this organization''s shared workspaces'
      USING ERRCODE = '55000';
  END IF;

  SELECT session.* INTO source_session FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_source_workspace_id
    AND session.id = p_source_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork source session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  -- A private source remains owner-only. A workspace-shared source follows
  -- current workspace authority, and the fork becomes a fresh session owned
  -- by the actor. This is what lets any authorized collaborator fork shared
  -- work privately without retaining the source owner's authority.
  IF source_session.visibility = 'user_private' AND (
    source_session.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR source_session.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  )
  THEN RAISE EXCEPTION 'session fork source session is private'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
    'session.fork', p_source_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- The acknowledgement is content-exposure evidence, not a blanket checkbox:
  -- it is required only when private source content crosses into workspace scope.
  IF source_session.visibility = 'user_private'
    AND p_destination_visibility = 'workspace_shared'
    AND NOT p_workspace_shared_acknowledged
  THEN RAISE EXCEPTION 'private-to-workspace fork requires explicit acknowledgement'
    USING ERRCODE = '22023'; END IF;

  PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, true
  );

  SELECT coalesce(jsonb_agg(
    CASE WHEN resource.value ->> 'connectionType' = 'github_personal'
      THEN resource.value
        - 'provider' - 'connectionType' - 'credentialBindingId' - 'access'
        - 'repositoryId' - 'installationId' - 'projectId' - 'connectionId'
        - 'githubInstallationId' - 'githubRepositoryId'
      ELSE resource.value
        - 'credentialBindingId' - 'connectionId' - 'installationId'
        - 'projectId' - 'githubInstallationId'
    END
    ORDER BY resource.ordinality
  ), '[]'::jsonb) INTO destination_resources
  FROM jsonb_array_elements(source_session.resources)
    WITH ORDINALITY AS resource(value, ordinality);

  DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;
  CREATE TEMP TABLE opengeni_session_fork_history_spool (
    position numeric NOT NULL,
    item jsonb NOT NULL,
    item_codec_version integer,
    active boolean NOT NULL,
    provider_artifact_invalidated_at timestamptz,
    provider_artifact_invalidation_reason text,
    provider_artifact_invalidated_by_attempt_id uuid,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.opengeni_session_fork_history_spool (
    position, item, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT source_item.position, source_item.item,
      source_item.item_codec_version, source_item.active,
      source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id,
      source_item.created_at
    FROM session_history_items source_item
    WHERE source_item.account_id = p_account_id
      AND source_item.workspace_id = p_source_workspace_id
      AND source_item.session_id = p_source_session_id
    ORDER BY source_item.position;
  GET DIAGNOSTICS history_count = ROW_COUNT;

  SELECT coalesce(
      CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
        THEN (destination_workspace.settings ->> 'maxNestedAgentDepth')::integer END,
      configuration.max_nested_agent_depth
    ),
    CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
      THEN 'workspace' ELSE configuration.policy_source END
  INTO destination_depth, destination_depth_source
  FROM nested_agent_depth_configuration configuration
  WHERE configuration.singleton = true;
  IF destination_depth IS NULL OR destination_depth_source IS NULL THEN
    RAISE EXCEPTION 'session fork destination depth policy is unavailable'
      USING ERRCODE = '55000';
  END IF;

  destination_session_id := gen_random_uuid();
  public_destination_visibility := CASE p_destination_visibility
    WHEN 'user_private' THEN 'private' ELSE 'workspace' END;
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    visibility_write_capability_id::text, true);
  PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    p_source_workspace_id::text, true);

  -- This one insert establishes fresh ownership, authority epoch, provenance,
  -- root identity and singleton sandbox group. No live source authority is copied.
  INSERT INTO sessions (
    id, account_id, workspace_id, status,
    initial_message, initial_message_codec_version,
    title, title_source, instructions, policy_role,
    resources, skills, tools, metadata,
    created_by_kind, created_by_subject_id, created_by_context,
    owner_organization_membership_id, owner_subject_id,
    visibility, create_requested_visibility, authority_epoch,
    forked_from_session_id, forked_from_authority_epoch,
    forked_from_visibility, forked_at, forked_by_organization_membership_id,
    model, reasoning_effort, latency_mode, sandbox_backend, sandbox_os, sandbox_group_id,
    first_party_mcp_permissions, first_party_mcp_tools,
    initial_personal_connection_delegations, tool_policy,
    root_session_id, nested_agent_depth,
    max_nested_agent_depth_override, effective_max_nested_agent_depth,
    nested_agent_depth_policy_source, nested_agent_depth_policy_session_id,
    temporal_workflow_id, active_turn_id, variable_set_id,
    rig_id, rig_version_id, active_sandbox_id, active_epoch,
    working_dir, codex_pinned_credential_id, codex_last_credential_id,
    codex_pin_source, codex_compaction_mode,
    queue_version, queue_head_position, queue_tail_position, last_sequence
  ) VALUES (
    destination_session_id, p_account_id, p_source_workspace_id, 'idle',
    source_session.initial_message, source_session.initial_message_codec_version,
    source_session.title, source_session.title_source,
    source_session.instructions, source_session.policy_role,
    destination_resources, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'subject', p_actor_subject_id, jsonb_build_object(
      'fork', true,
      'sourceSessionId', p_source_session_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged
    ),
    actor_membership.id, actor_membership.subject_id,
    -- create_requested_visibility mirrors the destination the caller actually
    -- asked for. Leaving it at the column default made a private fork row
    -- internally inconsistent with its own visibility.
    p_destination_visibility, p_destination_visibility, 1,
    p_source_session_id, source_session.authority_epoch,
    source_session.visibility, clock_timestamp(), actor_membership.id,
    source_session.model, source_session.reasoning_effort, source_session.latency_mode,
    source_session.sandbox_backend, source_session.sandbox_os, destination_session_id,
    NULL, '[]'::jsonb, '[]'::jsonb,
    '{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,
    destination_session_id, 0, NULL, destination_depth,
    destination_depth_source, NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL,
    source_session.codex_compaction_mode,
    0, 0, 0, 1
  );

  INSERT INTO session_history_items (
    account_id, workspace_id, session_id, turn_id,
    position, item, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT p_account_id, p_source_workspace_id, destination_session_id, NULL,
      source_item.position, source_item.item, source_item.item_codec_version,
      source_item.active, source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at
    FROM pg_temp.opengeni_session_fork_history_spool source_item
    ORDER BY source_item.position;

  INSERT INTO session_events (
    account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  ) VALUES (
    p_account_id, p_source_workspace_id, destination_session_id, 1,
    'session.created', jsonb_build_object(
      'forked', true, 'sourceSessionId', p_source_session_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'visibility', public_destination_visibility,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
      'copiedHistoryItemCount', history_count
    ), clock_timestamp()
  ) RETURNING id INTO event_row_id;

  PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = p_source_workspace_id
  RETURNING counter.revision INTO destination_activity_revision;
  IF destination_activity_revision IS NULL THEN
    RAISE EXCEPTION 'session fork destination activity counter is unavailable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE sessions destination_session SET
    activity_revision = destination_activity_revision,
    activity_revision_pending_xid = NULL
  WHERE destination_session.id = destination_session_id
    AND destination_session.activity_revision_pending_xid
      = pg_current_xact_id()::text::bigint;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork activity was not finalized'
    USING ERRCODE = '55000'; END IF;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;

  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = visibility_write_capability_id;
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id, 'eventSequence', 1,
    'sessionId', destination_session_id, 'workspaceId', p_source_workspace_id,
    'visibility', p_destination_visibility, 'authorityEpoch', 1,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
    'copiedHistoryItemCount', history_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id; event_sequence := 1;
  session_id := destination_session_id; workspace_id := p_source_workspace_id;
  visibility := p_destination_visibility; authority_epoch := 1;
  copied_history_item_count := history_count; replay := false;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_activity_gate_state',
    CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END, true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    CASE WHEN previous_gate_workspace IS NULL THEN '' ELSE previous_gate_workspace END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$$;

-- CREATE OR REPLACE evaluates `SET search_path FROM CURRENT` against the
-- migrator connection. Re-pin every replaced definer to the target schema so
-- a dedicated-schema install cannot retain the connection's broader fallback
-- path (notably opengeni_private/public) in its function metadata.
DO $pin_session_tenancy_definers$
DECLARE
  target_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.reap_stale_interaction_transitions(bigint) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.reap_sandbox_leases(bigint,bigint,bigint,bigint) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.claim_terminal_retained_processes(uuid,integer,bigint) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.request_due_sandbox_rotations(bigint,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.acquire_sandbox_reaper_session_tenancy_fences() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.acquire_due_retained_process_session_tenancy_fences() '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.acquire_due_sandbox_rotation_session_tenancy_fences(bigint) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.acquire_scoped_machine_session_tenancy_fences(uuid,uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.acquire_organization_session_tenancy_fences(uuid) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.assert_session_tenancy_quiescent(uuid,uuid,uuid,boolean) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.transition_session_visibility(uuid,uuid,uuid,text,text,integer,text,text,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
  EXECUTE format(
    'ALTER FUNCTION %I.fork_session_content(uuid,uuid,uuid,text,uuid,text,boolean,text,text,integer) '
      || 'SET search_path = pg_catalog, %I, pg_temp',
    target_schema,
    target_schema
  );
END
$pin_session_tenancy_definers$;


RESET statement_timeout;
RESET lock_timeout;
