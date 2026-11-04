-- deployment-mode: rolling
-- Repositories a person removed from a running session. Each entry is
-- `{id, resource, removedAt, sandboxCleanupPending}`: the record lasts until a
-- person attaches the repository again, so an agent cannot re-attach it and
-- queued turns, children and goal continuations leave it out. The
-- `sandboxCleanupPending` flag clears once a turn removed the repository
-- folder and credential binding from the sandbox.
--
-- A constant default is metadata-only, so the column is added without a
-- table rewrite. The previous release neither reads nor writes it, and the
-- fork routines start from the complete source row, so a fork keeps the
-- record of its source.
SET LOCAL lock_timeout = '5s';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS removed_repositories jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE sessions ADD CONSTRAINT sessions_removed_repositories_array_check
  CHECK (jsonb_typeof(removed_repositories) = 'array')
  NOT VALID;
