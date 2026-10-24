-- deployment-mode: rolling
-- Approval for each agent use of chosen secrets. A rule marks a vault item, or
-- one of its fields by name key, as needing the acting person's approval every
-- time an agent uses it; the agent still sees the item and can refer to it. A
-- request row records one blocked use (which chat, which item and field, which
-- surface and destination) and, once the person decides, the grant it became:
-- one use, this chat, or a time window across their chats in the workspace.
-- Neither table holds a value. The vault tables are untouched, so old
-- binaries never read these tables; new binaries reach them through ordinary
-- row security.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Keyed by item and field name key (empty for the whole item), so a rule on a
-- connected vault's item survives every mirror refresh that keeps the item.
CREATE TABLE secret_approval_rules (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  item_id uuid NOT NULL,
  field_key text NOT NULL DEFAULT '' CHECK (char_length(field_key) <= 200),
  vault_id uuid NOT NULL,
  created_by_subject_id text NOT NULL
    CHECK (char_length(created_by_subject_id) BETWEEN 1 AND 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_id, field_key)
);

CREATE TABLE secret_use_approvals (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- The person the requesting run acts for; only they decide.
  approver_subject_id text NOT NULL
    CHECK (char_length(approver_subject_id) BETWEEN 1 AND 512),
  -- [{vaultId, itemId, fieldKey, vaultName, itemName, fieldName}], no values.
  targets jsonb NOT NULL
    CHECK (jsonb_typeof(targets) = 'array' AND jsonb_array_length(targets) BETWEEN 1 AND 50),
  surface text NOT NULL CHECK (char_length(surface) BETWEEN 1 AND 64),
  tool_name text NOT NULL CHECK (char_length(tool_name) BETWEEN 1 AND 200),
  destination text CHECK (destination IS NULL OR char_length(destination) <= 500),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'used', 'revoked')),
  scope text CHECK (scope IN ('once', 'session', 'window')),
  -- A grant's end; null for a chat grant, which lasts until revoked.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by_subject_id text CHECK (char_length(decided_by_subject_id) <= 512),
  used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_subject_id text CHECK (char_length(revoked_by_subject_id) <= 512),
  CHECK ((status IN ('approved', 'used', 'revoked')) = (scope IS NOT NULL)),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX secret_use_approvals_grants_idx
  ON secret_use_approvals (workspace_id, approver_subject_id)
  WHERE status = 'approved';
CREATE INDEX secret_use_approvals_targets_idx
  ON secret_use_approvals USING gin (targets jsonb_path_ops)
  WHERE status = 'approved';
CREATE INDEX secret_use_approvals_session_idx
  ON secret_use_approvals (session_id, created_at DESC);

ALTER TABLE secret_approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_approval_rules FORCE ROW LEVEL SECURITY;
-- Rules follow the item: an Only me vault reaches every workspace of its
-- owner, so a rule is visible across the organization. Who may change one is
-- decided by the API against vault reach.
CREATE POLICY account_isolation ON secret_approval_rules
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
ALTER TABLE secret_use_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_use_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON secret_use_approvals
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
REVOKE ALL ON TABLE secret_approval_rules FROM PUBLIC;
REVOKE ALL ON TABLE secret_use_approvals FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON secret_approval_rules TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON secret_use_approvals TO opengeni_app;
  END IF;
END $$;
