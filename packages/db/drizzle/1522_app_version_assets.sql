-- deployment-mode: rolling
-- Multi-file app versions (docs/published-sites.md "Multi-file apps"): an
-- app version can carry the asset files of a normal build (JS chunks, CSS,
-- fonts, images) next to its HTML. asset_manifest lists them (path, SHA-256,
-- size) with the version's unguessable URL token; the bytes live in object
-- storage, content-addressed per workspace. NULL is a single-file app, so
-- adding the column rewrites no rows, and the previous release, which never
-- reads or writes it, keeps working (it serves such a version's HTML without
-- its files until it is gone). The immutability trigger is a row trigger and
-- does not fire for ADD COLUMN.
SET LOCAL lock_timeout = '5s';
ALTER TABLE workspace_artifact_versions ADD COLUMN IF NOT EXISTS asset_manifest jsonb;
COMMENT ON COLUMN workspace_artifact_versions.asset_manifest IS 'Asset files of a multi-file build: {token, files: [{path, sha256, sizeBytes}]}; null for a single-file app.';
