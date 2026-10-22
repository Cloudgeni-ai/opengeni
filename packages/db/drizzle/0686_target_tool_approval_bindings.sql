-- deployment-mode: rolling
-- Additive discriminator. Existing writers retain v1; unknown v2 capabilities
-- cannot match the old catalog equality check. Consumed operation keys never change.
ALTER TABLE tool_gateway_approval_capabilities
  ADD COLUMN binding_version integer NOT NULL DEFAULT 1,
  ADD COLUMN target_binding_digest text,
  ALTER COLUMN catalog_digest DROP NOT NULL;
ALTER TABLE tool_gateway_approval_capabilities
  ADD CONSTRAINT tool_gateway_approval_capabilities_binding_chk CHECK (
    (binding_version = 1 AND catalog_digest IS NOT NULL AND target_binding_digest IS NULL)
    OR (binding_version = 2 AND catalog_digest IS NULL AND target_binding_digest IS NOT NULL
      AND target_binding_digest ~ '^[0-9a-f]{64}$')
  );
