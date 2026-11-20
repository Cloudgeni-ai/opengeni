-- deployment-mode: rolling
-- The customizable sidebar (docs/sidebar-layout.md): one row holds the
-- workspace default (subject_id IS NULL), which workspace admins set, and one
-- row per person holds their own changes on top of it (hidden items, their
-- own items, their order). Layouts are JSON the API validates; readers ignore
-- item types they don't know, so mixed versions never break each other.
-- revision is a compare-and-set counter so concurrent edits never overwrite
-- each other silently.
--
-- Presentation only: an item never grants access. The API resolves every app
-- link against the reader's own access and drops what they can't open.
--
-- Rolling: a new table the previous release never reads or writes. No
-- backfill; a workspace without a row has an empty default.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE sidebar_layouts (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id text,
  layout jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sidebar_layouts_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT sidebar_layouts_bounds_check
    CHECK (jsonb_typeof(layout) = 'object' AND octet_length(layout::text) <= 262144
      AND revision >= 1
      AND (subject_id IS NULL OR length(subject_id) BETWEEN 1 AND 512)
      AND (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 512))
);
CREATE UNIQUE INDEX sidebar_layouts_workspace_default_uq
  ON sidebar_layouts (workspace_id) WHERE subject_id IS NULL;
CREATE UNIQUE INDEX sidebar_layouts_personal_uq
  ON sidebar_layouts (workspace_id, subject_id) WHERE subject_id IS NOT NULL;
COMMENT ON TABLE sidebar_layouts IS 'Sidebar layout: the workspace default (subject_id NULL) and each person''s own changes on top. Presentation only, never authority.';

ALTER TABLE sidebar_layouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sidebar_layouts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE sidebar_layouts FROM PUBLIC;
CREATE POLICY workspace_isolation ON sidebar_layouts
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $opengeni_sidebar_layout_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON sidebar_layouts FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sidebar_layouts TO opengeni_app;
  END IF;
END
$opengeni_sidebar_layout_grants$;
