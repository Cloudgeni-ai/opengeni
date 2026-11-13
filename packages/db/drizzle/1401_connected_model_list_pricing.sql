-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: organization_model_provider_custom_models holds a few curated models per organization, so validating this check here is instant.
-- An organization's OpenAI, Azure OpenAI or OpenAI-compatible model can say
-- what its usage costs, since these providers report no cost: the catalogue
-- model whose list rate it shares (an Azure deployment's base model, read
-- from Azure's answer when the deployment is added or set by an
-- administrator), or the administrator's own rate. Usage estimates, spend
-- limits and Insights then price its calls instead of leaving them unpriced.
-- Both columns are null for a model with no known price (every existing row).
--
-- Rolling: two nullable columns and a check that every existing row (both
-- null) satisfies. The previous release never reads or writes them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_provider_custom_models
  ADD COLUMN price_basis_model_id text,
  ADD COLUMN list_pricing jsonb;

COMMENT ON COLUMN organization_model_provider_custom_models.price_basis_model_id IS
  'OpenAI, Azure OpenAI and OpenAI-compatible models only: the catalogue model whose list rate prices this model (an Azure deployment''s base model); null when unknown or list_pricing is set.';
COMMENT ON COLUMN organization_model_provider_custom_models.list_pricing IS
  'OpenAI, Azure OpenAI and OpenAI-compatible models only: the administrator''s own list rate in USD micros per 1M tokens; null when unknown or priced from price_basis_model_id.';

ALTER TABLE organization_model_provider_custom_models
  ADD CONSTRAINT organization_model_provider_custom_models_list_price_chk CHECK (
    (price_basis_model_id IS NULL OR list_pricing IS NULL)
    AND (
      (price_basis_model_id IS NULL AND list_pricing IS NULL)
      OR provider_kind IN ('openai', 'azure_openai', 'openai_compatible')
    )
    AND (
      price_basis_model_id IS NULL
      OR (
        octet_length(price_basis_model_id) BETWEEN 1 AND 256
        AND price_basis_model_id ~ '^[!-~]+$'
      )
    )
    AND (list_pricing IS NULL OR jsonb_typeof(list_pricing) = 'object')
  );
