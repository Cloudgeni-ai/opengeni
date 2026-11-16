-- deployment-mode: rolling
-- One active connection per owner, integration and verified external account.
-- Writers that verify which provider account a connection belongs to stamp
-- an opaque key (see connectionAccountIdentityKey); migration 1480 makes it
-- unique among a single owner's live connections. Null (every existing row,
-- and any connection whose account is not verified) is never deduplicated.
--
-- Rolling: a nullable column and a check for new writes (every existing row
-- is null, so there is nothing to validate).
-- The previous release never reads or writes it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE connections
  ADD COLUMN account_identity_key text;

ALTER TABLE connections
  ADD CONSTRAINT connections_account_identity_key_check CHECK (
    account_identity_key IS NULL OR account_identity_key ~ '^[0-9a-f]{64}$'
  ) NOT VALID;

COMMENT ON COLUMN connections.account_identity_key IS
  'SHA-256 of the integration and verified provider account this connection belongs to; null when unverified. Unique per organization and owner among live rows.';
