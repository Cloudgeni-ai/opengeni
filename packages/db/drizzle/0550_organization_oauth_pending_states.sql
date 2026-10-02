-- deployment-mode: rolling
-- Reuse encrypted, expiring OAuth attempts for organization-owned model sign-in.
ALTER TABLE integration_oauth_pending_states ALTER COLUMN workspace_id DROP NOT NULL;
DROP POLICY integration_oauth_pending_states_workspace_scope ON integration_oauth_pending_states;
CREATE POLICY integration_oauth_pending_states_scope ON integration_oauth_pending_states
  USING (
    (workspace_id IS NOT NULL AND opengeni_private.workspace_rls_visible(account_id, workspace_id))
    OR (workspace_id IS NULL AND opengeni_private.current_workspace_id() IS NULL
      AND opengeni_private.organization_model_provider_scope_visible(account_id))
  )
  WITH CHECK (
    (workspace_id IS NOT NULL AND opengeni_private.workspace_rls_visible(account_id, workspace_id))
    OR (workspace_id IS NULL AND opengeni_private.current_workspace_id() IS NULL
      AND opengeni_private.organization_model_provider_scope_visible(account_id))
  );
