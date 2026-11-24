-- deployment-mode: rolling
-- Use-only secrets (docs/secrets.md, "Who can see a value").
--
-- * vault_item_use_only: items whose values can be used by reference but are
--   never shown again to anyone, their creator and admins included. A row is
--   only ever added: the runtime role may read and insert, never update or
--   delete, so marking an item use-only cannot be undone through Opengeni.
--   Permanently deleting the item (or its vault or organization) removes the
--   row with it.
--
-- Rolling: a new table the previous release never reads. The previous
-- release ignores the marks, so items marked while it still serves requests
-- stay revealable through it until the rollout completes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE vault_item_use_only (
  account_id uuid NOT NULL,
  item_id uuid NOT NULL,
  set_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vault_item_use_only_pkey PRIMARY KEY (account_id, item_id),
  CONSTRAINT vault_item_use_only_set_by_subject_id_check
    CHECK (set_by_subject_id IS NULL OR char_length(set_by_subject_id) BETWEEN 1 AND 512),
  CONSTRAINT vault_item_use_only_account_id_fkey FOREIGN KEY (account_id)
    REFERENCES managed_accounts(id) ON DELETE CASCADE,
  CONSTRAINT vault_item_use_only_item_id_fkey FOREIGN KEY (item_id)
    REFERENCES vault_items(id) ON DELETE CASCADE
);
COMMENT ON TABLE vault_item_use_only IS 'Vault items whose values are never revealed again; agents still use them by reference.';

CREATE INDEX vault_item_use_only_item_idx ON vault_item_use_only (item_id);

ALTER TABLE vault_item_use_only ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_item_use_only FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON vault_item_use_only
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

REVOKE ALL ON TABLE vault_item_use_only FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'REVOKE ALL ON TABLE vault_item_use_only FROM opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE vault_item_use_only TO opengeni_app';
  END IF;
END
$$;
