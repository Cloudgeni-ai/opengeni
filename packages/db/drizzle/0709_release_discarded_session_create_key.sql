-- deployment-mode: rolling
-- A session whose start fails before its first event or turn is discarded, so
-- it no longer lingers as a queued session that nothing will run. A keyed
-- create also releases its durable idempotency winner at the same time, so a
-- retry with the same key creates the session again instead of failing to
-- replay a row that no longer exists.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION opengeni_private.release_discarded_session_create_key_v1(
  p_workspace_id uuid,
  p_idempotency_key text,
  p_session_id uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $release$
DECLARE
  released integer;
BEGIN
  -- Only a winner whose session row is already gone can be released. The
  -- caller deletes the uninitialized shell earlier in this same transaction
  -- while holding the key's admission lock.
  IF EXISTS (SELECT 1 FROM sessions WHERE id = p_session_id) THEN
    RETURN false;
  END IF;
  DELETE FROM session_create_idempotency_guard
  WHERE workspace_id = p_workspace_id
    AND idempotency_key = p_idempotency_key
    AND outcome = 'session'
    AND session_id = p_session_id;
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released = 1;
END
$release$;

DO $release_discarded_session_create_key$
DECLARE
  target_schema text := current_schema();
  target_role record;
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.release_discarded_session_create_key_v1(uuid,text,uuid)
    FROM PUBLIC;
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.release_discarded_session_create_key_v1(uuid,text,uuid) SET search_path = pg_catalog, %I, pg_temp',
    target_schema
  );
  -- Whoever may delete sessions may release the key of one it just deleted.
  FOR target_role IN
    SELECT DISTINCT roles.rolname
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) acl
    JOIN pg_catalog.pg_roles roles ON roles.oid = acl.grantee
    WHERE namespace.nspname = target_schema
      AND relation.relname = 'sessions'
      AND acl.privilege_type = 'DELETE'
      AND acl.grantee <> relation.relowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.release_discarded_session_create_key_v1(uuid,text,uuid) TO %I',
      target_role.rolname
    );
  END LOOP;
END $release_discarded_session_create_key$;
