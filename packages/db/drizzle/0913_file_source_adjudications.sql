-- deployment-mode: rolling
-- An operator records privately verified legacy upload provenance here before
-- the following maintenance migration. Runtime roles have no table access.
CREATE TABLE opengeni_private.file_source_adjudications (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('human_shared', 'owner_only')),
  owner_subject_id text CHECK (owner_subject_id IS NULL OR length(trim(owner_subject_id)) > 0),
  attested_by text NOT NULL CHECK (length(trim(attested_by)) > 0),
  attested_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON opengeni_private.file_source_adjudications FROM PUBLIC;
DO $runtime_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON opengeni_private.file_source_adjudications FROM opengeni_app;
  END IF;
END $runtime_acl$;
