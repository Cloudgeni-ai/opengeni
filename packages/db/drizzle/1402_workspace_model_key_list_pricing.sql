-- deployment-mode: rolling
-- A workspace's own OpenAI, Azure OpenAI or OpenAI-compatible model key can
-- say what its model's usage costs, like an organization's (1401): the
-- catalogue model whose list rate it shares (an Azure deployment's base
-- model, read from Azure's answer when the key is connected or set by an
-- administrator), or the administrator's own rate. Both columns are null for
-- every other connection and for a model with no known price (every existing
-- row). Setting them never changes the connection's version, so the model's
-- id and every accepted turn on it stay as they are.
--
-- Rolling: two nullable columns and a check added NOT VALID in a short
-- transaction; 1403 validates it. The previous release never reads or writes
-- them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE connections
  ADD COLUMN price_basis_model_id text,
  ADD COLUMN list_pricing jsonb;

COMMENT ON COLUMN connections.price_basis_model_id IS
  'Workspace OpenAI, Azure OpenAI and OpenAI-compatible model keys only: the catalogue model whose list rate prices the key''s model (an Azure deployment''s base model); null when unknown or list_pricing is set.';
COMMENT ON COLUMN connections.list_pricing IS
  'Workspace OpenAI, Azure OpenAI and OpenAI-compatible model keys only: the administrator''s own list rate in USD micros per 1M tokens; null when unknown or priced from price_basis_model_id.';

ALTER TABLE connections
  ADD CONSTRAINT connections_list_price_chk CHECK (
    (price_basis_model_id IS NULL OR list_pricing IS NULL)
    AND (
      (price_basis_model_id IS NULL AND list_pricing IS NULL)
      OR (subject_id IS NULL AND kind = 'api_key' AND metadata ? 'directModelProvider')
    )
    AND (
      price_basis_model_id IS NULL
      OR (
        octet_length(price_basis_model_id) BETWEEN 1 AND 256
        AND price_basis_model_id ~ '^[!-~]+$'
      )
    )
    AND (list_pricing IS NULL OR jsonb_typeof(list_pricing) = 'object')
  ) NOT VALID;
