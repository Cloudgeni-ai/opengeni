-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: these tables hold a handful of provider connection rows per organization, so validating under the same lock finishes instantly
-- Organization Azure OpenAI can sign in with Microsoft Entra ID instead of an
-- API key: the organization's own app registration and client secret, or the
-- deployment's own identity when the operator enabled it. The connection row
-- and its operation receipt gain a non-secret `auth_method`; every existing
-- row is an API-key connection, so the column defaults to `api_key` (a
-- metadata-only default). Entra methods are admitted for `azure_openai` only.
-- The secret material (an app's client secret) stays in the existing
-- encrypted `credential_encrypted` column. An older binary never writes the
-- new methods and never reads the new column. Ownership, encryption and RLS
-- are unchanged; no row is read or rewritten.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_provider_connections
  ADD COLUMN auth_method text NOT NULL DEFAULT 'api_key';
ALTER TABLE organization_model_provider_connections
  ADD CONSTRAINT organization_model_provider_connections_auth_method_chk CHECK (
    auth_method IN ('api_key', 'entra_client_secret', 'entra_deployment_identity')
    AND (auth_method = 'api_key' OR provider_kind = 'azure_openai')
  ) NOT VALID;
ALTER TABLE organization_model_provider_connections
  VALIDATE CONSTRAINT organization_model_provider_connections_auth_method_chk;

-- An idempotent replay returns the committed result, its method included.
ALTER TABLE organization_model_provider_connection_operations
  ADD COLUMN result_auth_method text NOT NULL DEFAULT 'api_key';
ALTER TABLE organization_model_provider_connection_operations
  ADD CONSTRAINT organization_model_provider_connection_operations_auth_chk CHECK (
    result_auth_method IN ('api_key', 'entra_client_secret', 'entra_deployment_identity')
    AND (result_auth_method = 'api_key' OR provider_kind = 'azure_openai')
  ) NOT VALID;
ALTER TABLE organization_model_provider_connection_operations
  VALIDATE CONSTRAINT organization_model_provider_connection_operations_auth_chk;
