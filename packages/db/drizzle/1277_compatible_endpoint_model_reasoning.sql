-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: organization_model_provider_custom_models holds a few curated models per organization, so validating this check here is instant.
-- A model of an organization's OpenAI-compatible endpoint can declare the
-- reasoning levels it accepts as `reasoning_effort` and the one it uses by
-- default, read from the endpoint's model listing or set by an organization
-- administrator. Chats then offer those levels and send the chosen one. Both
-- columns are null for a model that declares none (every existing row).
--
-- Rolling: two nullable columns and a check that every existing row (both
-- null) satisfies. The previous release never reads or writes them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_model_provider_custom_models
  ADD COLUMN reasoning_efforts text[],
  ADD COLUMN default_reasoning_effort text;

COMMENT ON COLUMN organization_model_provider_custom_models.reasoning_efforts IS
  'OpenAI-compatible endpoint models only: the reasoning levels the model accepts as reasoning_effort, lowest first; null when it declares none.';
COMMENT ON COLUMN organization_model_provider_custom_models.default_reasoning_effort IS
  'OpenAI-compatible endpoint models only: the declared level chats start with; set exactly when reasoning_efforts is.';

ALTER TABLE organization_model_provider_custom_models
  ADD CONSTRAINT organization_model_provider_custom_models_reasoning_chk CHECK (
    (reasoning_efforts IS NULL) = (default_reasoning_effort IS NULL)
    AND (
      reasoning_efforts IS NULL
      OR (
        provider_kind = 'openai_compatible'
        AND cardinality(reasoning_efforts) BETWEEN 1 AND 7
        AND reasoning_efforts <@ ARRAY['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']::text[]
        AND default_reasoning_effort = ANY (reasoning_efforts)
      )
    )
  );
