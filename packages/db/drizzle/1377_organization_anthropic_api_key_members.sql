-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: organization model provider connections hold one row per organization and provider kind, so validating these checks here is instant.
-- An organization's Anthropic API connection can hold several API keys. Its
-- own key stays the first member; the others are stored beside it, each
-- encrypted like the connection's key, with a label and the Anthropic
-- organization the key belongs to. Each session keeps one key while it
-- serves (Anthropic's prompt cache belongs to the key's organization), and a
-- key Anthropic refuses for lack of credits is recorded so later turns skip
-- it until an administrator checks it again. These keys never serve Claude
-- subscription models.
--
-- Rolling: two nullable columns. The previous release never reads them, so
-- it keeps sending the connection's own key, as it does today.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_provider_connections
  ADD COLUMN api_key_members jsonb,
  ADD COLUMN api_key_credit_refusals jsonb;

COMMENT ON COLUMN organization_model_provider_connections.api_key_members IS
  'Anthropic API connections only: the organization''s further API keys, as an array of {id, label, credentialEncrypted, credentialDigest, anthropicOrganizationId, createdAt, createdBySubjectId}. The connection''s own key is the first member.';
COMMENT ON COLUMN organization_model_provider_connections.api_key_credit_refusals IS
  'Anthropic API connections only: member id to the time Anthropic refused that key for lack of credits. The connection''s own key is the member primary-v<version>.';

ALTER TABLE organization_model_provider_connections
  ADD CONSTRAINT organization_model_provider_connections_api_key_members_chk CHECK (
    api_key_members IS NULL
    OR (provider_kind = 'anthropic'
      AND jsonb_typeof(api_key_members) = 'array'
      AND jsonb_array_length(api_key_members) <= 63)
  ),
  ADD CONSTRAINT organization_model_provider_connections_api_key_refusals_chk CHECK (
    api_key_credit_refusals IS NULL
    OR (provider_kind = 'anthropic' AND jsonb_typeof(api_key_credit_refusals) = 'object')
  );
