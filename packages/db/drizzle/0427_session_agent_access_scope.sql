-- deployment-mode: rolling
-- Session agent-access scope, opaque end-user label, and memory scope.
--
-- agent_access declares how far a live agent attempt on this session may
-- reach across the workspace and how far other attempts may reach into it:
-- 'workspace' (today's behaviour), 'user' (only sessions carrying the same
-- end-user label), or 'session' (only its own root tree). end_user_source /
-- end_user_id is an opaque product label, never a subject or authority.
-- memory_scope selects the typed Workspace Memory selector an agent reads and
-- writes ('workspace', 'user', 'session') or disables Memory tools ('off').
--
-- Every existing row keeps the workspace-wide defaults, so an old binary and a
-- new one observe identical behaviour until a caller opts a new session into a
-- narrower scope. Adding a defaulted column is metadata-only and RLS-immune; the
-- CHECK validations and the partial index scan a table in which no row yet
-- carries a label, so neither writes index tuples nor needs a posture window.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE sessions
  ADD COLUMN agent_access text NOT NULL DEFAULT 'workspace',
  ADD COLUMN end_user_source text,
  ADD COLUMN end_user_id text,
  ADD COLUMN memory_scope text NOT NULL DEFAULT 'workspace',
  ADD CONSTRAINT sessions_agent_access_check
    CHECK (agent_access IN ('session', 'user', 'workspace')),
  ADD CONSTRAINT sessions_end_user_pair_check
    CHECK ((end_user_source IS NULL) = (end_user_id IS NULL)),
  ADD CONSTRAINT sessions_memory_scope_check
    CHECK (memory_scope IN ('workspace', 'user', 'session', 'off'));

CREATE INDEX sessions_workspace_end_user_idx
  ON sessions (workspace_id, end_user_source, end_user_id)
  WHERE end_user_id IS NOT NULL;
