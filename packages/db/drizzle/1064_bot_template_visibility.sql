-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: bot_templates holds at most 200 rows per workspace, so checking the new column's constant default is instant.
-- A bot template is either Only me (`private`: only whoever saved it sees
-- it) or shared with everyone in the workspace (`workspace`), like a chat.
-- Every existing template was shared with the workspace, which the default
-- keeps. The constant default makes this a catalog-only change. A previous
-- binary neither names nor reads the column: its inserts take the default,
-- and while it serves, it lists a new Only me template like any other until
-- the rollout completes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE bot_templates ADD COLUMN visibility text NOT NULL DEFAULT 'workspace'
  CONSTRAINT bot_templates_visibility_check CHECK (visibility IN ('private', 'workspace'));
-- An Only me template belongs to a person. Every existing row is shared, so
-- the rule holds already and is added NOT VALID to skip the scan.
ALTER TABLE bot_templates ADD CONSTRAINT bot_templates_private_owner_check
  CHECK (visibility = 'workspace' OR created_by_subject_id IS NOT NULL) NOT VALID;
