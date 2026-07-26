-- The REAL PTY terminal (ttyd pty-ws) data-plane URL cache (P5.t).
--
-- The interactive terminal is now a REAL PTY streamed over the SAME Modal raw-TLS
-- tunnel the desktop noVNC uses (symmetric with Channel-B), replacing the broken
-- stateless ptyWrite-over-HTTP path (Modal kept the live PTY process handle in an
-- in-memory per-call activeProcesses Map; a fresh session per HTTP call hit
-- "session not found"). ttyd listens on 7681 in-box and is exposed over a SEPARATE
-- provider tunnel from the 6080 desktop noVNC — a DIFFERENT URL.
--
-- The lease already caches the single desktop tunnel URL (data_plane_url, the 6080
-- noVNC plane). The terminal tunnel (7681) resolves to its own URL, so it needs
-- its own cache column. mintTerminalStream records it here under the epoch fence
-- (recordLeaseTerminalDataPlaneUrl); the fast-path then re-mints only a fresh
-- scoped token against the cached URL (no box touch). It is reset to NULL on every
-- box re-key (commitWarmingToWarm / failWarmingToCold / drain-cold / warming-death
-- reset) exactly like data_plane_url, so a stale URL never survives a rollover.
--
-- Forward-only, behavior-preserving: NULLable, no backfill needed (a warm lease
-- re-resolves + records it on the next terminal attach; a cold/legacy row reads
-- NULL = "not yet minted").

ALTER TABLE "sandbox_leases"
  ADD COLUMN IF NOT EXISTS "terminal_data_plane_url" text;

-- Re-grant on the new column (idempotent; mirrors the boilerplate in 0018 so a
-- fresh opengeni_app role can read/write the added column).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
  END IF;
END $$;
