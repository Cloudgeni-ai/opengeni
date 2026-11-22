-- deployment-mode: rolling
-- Stored tool data marks stay until a manager resets the data
-- (docs/app-server-code.md, "Stored tool data").
--
-- * site_tool_data_resets: when a manager last reset a target (a collection,
--   or the app's SQL database). Marks and deleted shared syncs from before
--   that time no longer count; live shared syncs always do.
-- * site_tool_data_sources gains UPDATE, so a target marked again after a
--   reset refreshes its mark's time.
--
-- Rolling: a new table the previous release never reads, and an added
-- privilege. The previous release ignores resets, so it keeps treating reset
-- targets as marked (it refuses more, never less).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE site_tool_data_resets (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  -- 'collection:<name>' or 'sql', as in site_tool_data_sources.
  target text NOT NULL,
  reset_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_tool_data_resets_pkey PRIMARY KEY (workspace_id, site_id, target),
  CONSTRAINT site_tool_data_resets_target_check
    CHECK (target = 'sql' OR (target LIKE 'collection:%' AND char_length(target) BETWEEN 12 AND 80)),
  CONSTRAINT site_tool_data_resets_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT site_tool_data_resets_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
COMMENT ON TABLE site_tool_data_resets IS 'When a manager last reset an app collection or SQL database; earlier stored tool data marks no longer count.';

ALTER TABLE site_tool_data_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_tool_data_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON site_tool_data_resets
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE site_tool_data_resets FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE site_tool_data_resets FROM opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE site_tool_data_resets TO opengeni_app';
    EXECUTE 'GRANT UPDATE ON TABLE site_tool_data_sources TO opengeni_app';
  END IF;
END
$$;
