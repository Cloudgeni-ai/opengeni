-- deployment-mode: rolling
-- The optional code_search decision is frozen once per session, like
-- codex_compaction_mode, so a later deployment or workspace change never adds
-- the tool and its instruction to a running session and breaks its prompt
-- cache. NULL, which every existing row keeps, means off.
ALTER TABLE sessions ADD COLUMN code_search_enabled boolean;
