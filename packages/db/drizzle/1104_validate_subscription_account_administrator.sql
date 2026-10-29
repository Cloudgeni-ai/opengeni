-- deployment-mode: rolling
-- Validate the capability constraints 1103 replaced NOT VALID. The table holds
-- at most a few rows per live backend (0838), and VALIDATE takes only SHARE
-- UPDATE EXCLUSIVE, so concurrent grants keep running.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE opengeni_private.subscription_runtime_capabilities
  VALIDATE CONSTRAINT subscription_runtime_capabilities_kind_chk;
ALTER TABLE opengeni_private.subscription_runtime_capabilities
  VALIDATE CONSTRAINT subscription_runtime_capabilities_provider_chk;
