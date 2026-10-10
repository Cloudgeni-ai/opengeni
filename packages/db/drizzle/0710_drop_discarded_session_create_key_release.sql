-- deployment-mode: rolling
-- Only session shells created without an idempotency key are discarded when
-- their start fails. A keyed shell stays durable so a retry with the same key
-- repairs it, so its key is never released and 0709's routine is unused.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DROP FUNCTION IF EXISTS opengeni_private.release_discarded_session_create_key_v1(uuid, text, uuid);
