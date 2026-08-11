-- deployment-mode: maintenance
-- Clean-cut extension of the exact interaction-operation journal for browser
-- downloads. Replacing CHECK constraints requires a bounded maintenance window.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "interaction_resource_operations"
  DROP CONSTRAINT "interaction_resource_operations_resource_kind_check";

ALTER TABLE "interaction_resource_operations"
  ADD CONSTRAINT "interaction_resource_operations_resource_kind_check"
  CHECK ("resource_kind" IN (
    'network_route',
    'site_auth_connection',
    'auth_run',
    'intervention',
    'browser_download'
  ));

ALTER TABLE "interaction_resource_operations"
  DROP CONSTRAINT "interaction_resource_operations_kind_check";

ALTER TABLE "interaction_resource_operations"
  ADD CONSTRAINT "interaction_resource_operations_kind_check"
  CHECK ("kind" IN (
    'create',
    'update',
    'start',
    'report',
    'protected_fill',
    'verify',
    'resolve',
    'save'
  ));
