-- deployment-mode: maintenance
-- Complete the saved-browser lifecycle with optimistic metadata updates and
-- replay-safe mutation receipts. Immutable revisions remain untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "browser_identities"
  ADD COLUMN "version" bigint NOT NULL DEFAULT 1;

ALTER TABLE "browser_identities"
  DROP CONSTRAINT "browser_identities_values_check";

ALTER TABLE "browser_identities"
  ADD CONSTRAINT "browser_identities_values_check" CHECK (
    octet_length("name") BETWEEN 1 AND 200
    AND "name" = btrim("name")
    AND octet_length("created_by_subject_id") BETWEEN 1 AND 1024
    AND "version" > 0
    AND "head_generation" >= 0
    AND "revision_count" >= 0
    AND (
      ("head_generation" = 0 AND "default_revision_id" IS NULL)
      OR ("head_generation" > 0 AND "default_revision_id" IS NOT NULL)
    )
  );

ALTER TABLE "interaction_resource_operations"
  DROP CONSTRAINT "interaction_resource_operations_resource_kind_check";

ALTER TABLE "interaction_resource_operations"
  ADD CONSTRAINT "interaction_resource_operations_resource_kind_check"
  CHECK ("resource_kind" IN (
    'browser_identity',
    'network_route',
    'site_auth_connection',
    'auth_run',
    'intervention',
    'browser_download'
  ));
