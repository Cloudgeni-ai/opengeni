-- deployment-mode: rolling
-- New code owns this resumable maintenance cursor; old binaries ignore it.
CREATE TABLE model_call_fact_reconciliation_progress (
  workspace_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  checkpoint jsonb,
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CHECK (checkpoint IS NULL OR jsonb_typeof(checkpoint) = 'object')
);
ALTER TABLE model_call_fact_reconciliation_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_call_fact_reconciliation_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON model_call_fact_reconciliation_progress
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
CREATE TABLE model_call_fact_reconciliation_candidates (
  workspace_id uuid NOT NULL,
  account_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  source_key text NOT NULL,
  PRIMARY KEY (workspace_id, turn_id, source_key),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
ALTER TABLE model_call_fact_reconciliation_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_call_fact_reconciliation_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON model_call_fact_reconciliation_candidates
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON model_call_fact_reconciliation_progress TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON model_call_fact_reconciliation_candidates TO opengeni_app;
  END IF;
END $$;
