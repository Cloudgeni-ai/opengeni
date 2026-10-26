-- deployment-mode: rolling
-- contract-step: 0910's converged backfill was the only user of these policies and this table; no release binary reads them
-- 0910's backfill has converged (the runner ledgers it only after its last,
-- empty batch). Remove its owner-only capability arms and progress row; new
-- messages are indexed by 0909's trigger.
SET LOCAL lock_timeout = '5s';

DROP POLICY IF EXISTS session_message_search_texts_backfill_v1 ON "session_message_search_texts";
DROP POLICY IF EXISTS session_events_message_search_backfill_v1 ON "session_events";
DROP POLICY IF EXISTS sessions_message_search_backfill_v1 ON "sessions";
DROP TABLE IF EXISTS opengeni_private.session_message_search_backfill;
