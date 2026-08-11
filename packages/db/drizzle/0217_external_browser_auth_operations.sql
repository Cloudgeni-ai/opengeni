-- deployment-mode: maintenance
-- Extend the durable interaction-operation journal with provider-managed
-- browser authentication. No rows are rewritten and no authority is exposed.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
    'external_auth',
    'verify',
    'resolve',
    'save'
  ));
