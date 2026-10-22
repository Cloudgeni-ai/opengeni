-- deployment-mode: rolling
-- Catalog observations are independent of quota, administrator policy and
-- provider refusals. Existing quota upserts preserve these nullable fields.
SET LOCAL lock_timeout = '5s';
ALTER TABLE subscription_connection_quota
  ADD COLUMN model_catalog_slugs text[],
  ADD COLUMN model_catalog_refresh_generation bigint,
  ADD COLUMN model_catalog_observed_at timestamptz,
  ADD COLUMN model_catalog_expires_at timestamptz,
  ADD CONSTRAINT subscription_model_catalog_observation_chk CHECK (
    (model_catalog_slugs IS NULL AND model_catalog_refresh_generation IS NULL
      AND model_catalog_observed_at IS NULL AND model_catalog_expires_at IS NULL)
    OR (model_catalog_slugs IS NOT NULL AND model_catalog_refresh_generation IS NOT NULL
      AND model_catalog_refresh_generation > 0 AND model_catalog_observed_at IS NOT NULL
      AND model_catalog_expires_at IS NOT NULL AND model_catalog_expires_at > model_catalog_observed_at)
  );
