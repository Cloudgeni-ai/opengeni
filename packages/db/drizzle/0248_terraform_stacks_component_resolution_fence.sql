-- deployment-mode: maintenance
-- Forward-only successor to migration 0247. Migration 0247 repaired the
-- Terraform Stacks provenance projection but did not prove that an affected
-- Pack component's polymorphic resolved_id still named the exact normalized
-- Plugin installation described by its canonical component fields.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

DO $maintenance_preflight_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
    AND EXISTS (
      SELECT 1
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'opengeni_app'
        AND pid <> pg_backend_pid()
    )
  THEN
    RAISE EXCEPTION
      'Terraform Stacks component resolution fence requires all opengeni_app sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$maintenance_preflight_guard$;

LOCK TABLE capability_plugins IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_plugin_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE capability_plugin_installations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE pack_installation_components IN ACCESS EXCLUSIVE MODE;

DO $terraform_stacks_component_resolution_fence$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pack_installation_components component
    WHERE (
        component.capability_id = 'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' = 'skill/library/terraform-stacks'
        OR EXISTS (
          SELECT 1
          FROM capability_plugin_installations installation
          JOIN capability_plugins plugin ON plugin.id = installation.plugin_id
          WHERE installation.id::text = component.resolved_id
            AND plugin.plugin_key = 'skill/library/terraform-stacks'
        )
      )
      AND (
        component.kind IS DISTINCT FROM 'plugin'
        OR component.capability_id IS DISTINCT FROM
          'plugin:skill/library/terraform-stacks'
        OR component.metadata ->> 'pluginKey' IS DISTINCT FROM
          'skill/library/terraform-stacks'
        OR component.metadata ->> 'version' IS DISTINCT FROM '0.0.1'
        OR component.digest IS DISTINCT FROM
          '3a58c98b725573b8fd524555b7ed9dbff04df4df9f8fad44e2e850bac3824809'
        OR NOT EXISTS (
          SELECT 1
          FROM capability_plugin_installations installation
          JOIN capability_plugins plugin ON plugin.id = installation.plugin_id
          JOIN capability_plugin_versions version
            ON version.id = installation.plugin_version_id
            AND version.plugin_id = installation.plugin_id
          WHERE installation.id::text = component.resolved_id
            AND installation.account_id = component.account_id
            AND installation.workspace_id = component.workspace_id
            AND installation.status = 'active'
            AND plugin.plugin_key = 'skill/library/terraform-stacks'
            AND version.version = '0.0.1'
            AND version.manifest_digest = component.digest
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Terraform Stacks component resolution fence found unexpected Pack state'
      USING ERRCODE = '23514';
  END IF;
END
$terraform_stacks_component_resolution_fence$;

RESET statement_timeout;
RESET lock_timeout;