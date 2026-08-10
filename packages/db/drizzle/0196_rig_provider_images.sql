-- deployment-mode: rolling
-- Exact rig-version definitions remain immutable. This additive operational
-- metadata records build-once provider image status and immutable identities.

ALTER TABLE rig_versions
  ADD COLUMN provider_images jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rig_versions
  ADD CONSTRAINT rig_versions_provider_images_object_chk
  CHECK (jsonb_typeof(provider_images) = 'object');