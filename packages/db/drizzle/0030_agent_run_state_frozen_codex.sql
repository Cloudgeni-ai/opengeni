-- 0030_agent_run_state_frozen_codex.sql
-- Cross-account encrypted-reasoning strip on the run-state REPLAY paths
-- (HOLE C of the multi-account verify): record which codex account froze a run
-- state so a resume on a DIFFERENT account can neutralize the frozen, account/
-- org-bound reasoning before replaying it.
--
-- The serialized RunState blob (used by the approval-decision resume and the
-- items-mode run-state fallback) round-trips `reasoning.encrypted_content` —
-- minted by the ChatGPT/Codex backend and bound to the producing account/org —
-- and the foreign reasoning ids the Responses backend validates. Unlike
-- session_history_items, the blob carries NO per-item producer tag, so we cannot
-- decide foreign-ness per item. Instead we stamp the freezing account on the
-- run-state row: when a turn resumes a state whose codex account differs from
-- the resuming turn's codex account, the replay path strips every reasoning
-- item's account-bound identity (encrypted_content + provider id) from the blob.
--
-- Nullable, no FK: provenance must OUTLIVE the account's hard-disconnect (an
-- ON DELETE SET NULL would erase the tag). NULL = frozen on the non-codex /
-- Azure path, or before this column existed. NULL frozen + NULL resume (the
-- non-codex / single-account case) compares equal, so those replays are
-- byte-identical no-ops.
--
-- Additive; every existing + new row defaults NULL. Runs under the runner's
-- pg_advisory_lock(727458).
ALTER TABLE "agent_run_states"
  ADD COLUMN IF NOT EXISTS "frozen_codex_credential_id" uuid;

-- Re-grant on the new column (idempotent; mirrors the boilerplate in earlier
-- migrations so a fresh opengeni_app role can read/write the added column).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
