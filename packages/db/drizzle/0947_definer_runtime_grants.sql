-- deployment-mode: rolling
-- Grants what 0937 withheld, now that the previous release knows these objects
-- (its runtime posture accepts them granted or withheld): runtime EXECUTE on
-- the event trigger dispatcher's due inventory and intake retention pass, the
-- recording recovery sweep's stalled-work inventory and the MCP Events and
-- source feed pumps' due inventories, and full DML on event_ingress_routes.
-- Readiness requires them from this release on. The recording retention
-- inventory 0946 withholds stays withheld until its own follow-up release.
--
-- Every configured application role gets them, as provisioning does.
DO $definer_runtime_grants$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.list_due_event_trigger_tasks_v1(integer), '
        || 'opengeni_private.prune_event_intake_v1(integer, integer, integer), '
        || 'opengeni_private.list_stalled_recording_work_v1(integer), '
        || 'opengeni_private.list_due_mcp_event_subscriptions_v1(integer), '
        || 'opengeni_private.list_due_event_source_feeds_v1(integer) TO %I',
      application_role
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE event_ingress_routes TO %I',
      application_role
    );
  END LOOP;
END $definer_runtime_grants$;
