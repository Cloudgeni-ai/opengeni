-- deployment-mode: rolling
-- 0929 granted the runtime role EXECUTE on two new SECURITY DEFINER routines
-- and DML on the new non-RLS table event_ingress_routes; 0930 and 0932 each
-- granted EXECUTE on one more definer, and so did 0935. The previous release's readiness check
-- rejects them (an unknown definer the runtime can call; unknown non-RLS
-- table grants), so a rolling deploy would take the old fleet out of service.
-- Withhold them until the release that knows these objects (runtime-posture
-- DEFERRED_RUNTIME_PRIVATE_ROUTINES and RUNTIME_DEFERRED_FULL_DML_TABLES) is
-- the previous release; a later migration grants them back. Event triggers
-- and the MCP Events and source feed pumps are off by default (OPENGENI_EVENT_TRIGGERS_ENABLED),
-- and the recording recovery sweep skips its pass while EXECUTE is withheld.
--
-- Every non-owner grantee loses them, not only opengeni_app: embedded
-- deployments provision their own runtime role. Grants passed on through
-- GRANT OPTION go too (CASCADE), and so do column-only table grants. A grant
-- this migration cannot revoke (made by another grantor) fails it loudly
-- rather than the previous fleet's readiness. Provisioning keeps them
-- withheld afterwards.
DO $definer_runtime_grants_deferred$
DECLARE
  grantee_name text;
BEGIN
  REVOKE ALL ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.prune_event_intake_v1(integer, integer, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.list_stalled_recording_work_v1(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(integer) FROM PUBLIC;
  REVOKE ALL ON TABLE event_ingress_routes FROM PUBLIC;

  FOR grantee_name IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(acl.grantee)
    FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) acl
    WHERE routine.oid IN (
        'opengeni_private.list_due_event_trigger_tasks_v1(integer)'::regprocedure,
        'opengeni_private.prune_event_intake_v1(integer, integer, integer)'::regprocedure,
        'opengeni_private.list_stalled_recording_work_v1(integer)'::regprocedure,
        'opengeni_private.list_due_mcp_event_subscriptions_v1(integer)'::regprocedure,
        'opengeni_private.list_due_event_source_feeds_v1(integer)'::regprocedure
      )
      AND acl.grantee <> 0
      AND acl.grantee <> routine.proowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(integer), '
        || 'opengeni_private.prune_event_intake_v1(integer, integer, integer), '
        || 'opengeni_private.list_stalled_recording_work_v1(integer), '
        || 'opengeni_private.list_due_mcp_event_subscriptions_v1(integer), '
        || 'opengeni_private.list_due_event_source_feeds_v1(integer) FROM %I CASCADE',
      grantee_name
    );
  END LOOP;

  -- REVOKE on a table also revokes its column privileges.
  FOR grantee_name IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(grants.grantee)
    FROM (
      SELECT acl.grantee, relation.relowner AS owner
      FROM pg_catalog.pg_class relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) acl
      WHERE relation.oid = 'event_ingress_routes'::regclass
      UNION
      SELECT acl.grantee, relation.relowner
      FROM pg_catalog.pg_attribute attribute
      JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
      WHERE attribute.attrelid = 'event_ingress_routes'::regclass
    ) grants
    WHERE grants.grantee <> 0
      AND grants.grantee <> grants.owner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE event_ingress_routes FROM %I CASCADE',
      grantee_name
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) acl
    WHERE routine.oid IN (
        'opengeni_private.list_due_event_trigger_tasks_v1(integer)'::regprocedure,
        'opengeni_private.prune_event_intake_v1(integer, integer, integer)'::regprocedure,
        'opengeni_private.list_stalled_recording_work_v1(integer)'::regprocedure,
        'opengeni_private.list_due_mcp_event_subscriptions_v1(integer)'::regprocedure,
        'opengeni_private.list_due_event_source_feeds_v1(integer)'::regprocedure
      )
      AND acl.grantee <> routine.proowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) acl
    WHERE relation.oid = 'event_ingress_routes'::regclass
      AND acl.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) acl
    WHERE attribute.attrelid = 'event_ingress_routes'::regclass
      AND acl.grantee <> relation.relowner
  ) THEN
    RAISE EXCEPTION 'a non-owner grant on a deferred definer or event_ingress_routes survived 0937';
  END IF;
END $definer_runtime_grants_deferred$;
