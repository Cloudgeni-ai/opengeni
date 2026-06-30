-- 0029_session_history_item_producer.sql
-- Cross-account encrypted-reasoning strip (multi-account codex, on top of P1).
--
-- Codex-subscription turns round-trip `reasoning.encrypted_content` — an opaque
-- blob minted by the ChatGPT/Codex backend that is account/org-bound. After a
-- manual switch from codex account A to B, the next turn on B replays history
-- items whose encrypted reasoning was minted by A, which B rejects (400). We tag
-- every conversation-truth row with the codex account that produced it so the
-- read path can drop the encrypted reasoning of any item NOT produced by the
-- turn's CURRENT codex account (message content is fully preserved).
--
-- Nullable, no FK: provenance must OUTLIVE the account's hard-disconnect (an
-- ON DELETE SET NULL would erase the tag). NULL = produced on the non-codex /
-- Azure path, or before this column existed (a legacy row replayed onto a codex
-- turn then has NULL != the live codex id, so it is stripped — defensive and
-- harmless: at most one turn of lost chain-of-thought continuity, never content).
--
-- Additive; every existing + new row defaults NULL, so non-codex and
-- single-account flows are byte-identical no-ops. Runs under the runner's
-- pg_advisory_lock(727458).
ALTER TABLE "session_history_items"
  ADD COLUMN IF NOT EXISTS "producer_codex_credential_id" uuid;

-- Re-grant on the new column (idempotent; mirrors the boilerplate in earlier
-- migrations so a fresh opengeni_app role can read/write the added column).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
