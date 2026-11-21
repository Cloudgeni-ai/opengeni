-- deployment-mode: rolling
-- "GitHub (your connection)" (docs/design/automations-and-events.md): a source
-- kind 'github_personal' whose feed reads one person's GitHub connection where
-- the workspace has no GitHub app. This adds the kind check again with it,
-- NOT VALID so it takes no long lock; 1526 validates it and 1527 drops the old
-- check. Every row the previous release writes satisfies both; it never
-- creates such a source, and its feed pump idles a feed it has no reader for.
SET LOCAL lock_timeout = '5s';

ALTER TABLE event_sources
  ADD CONSTRAINT event_sources_kind_v2_check CHECK (
    kind = ANY (ARRAY['webhook', 'github', 'slack', 'gmail', 'mcp', 'workspace', 'github_personal'])
  ) NOT VALID;
