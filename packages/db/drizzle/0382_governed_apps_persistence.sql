-- deployment-mode: maintenance
-- Governed workspace Apps persistence. Existing workspace_artifacts remain the
-- independent published-HTML surface and are intentionally untouched.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

DO $governed_apps_writer_drain_before_lock$
DECLARE
  configured_roles_text text := nullif(
    current_setting('opengeni.migration_application_roles', true), ''
  );
  configured_roles jsonb;
BEGIN
  IF configured_roles_text IS NULL THEN
    RAISE EXCEPTION
      '0382 governed Apps persistence requires an explicit application database role list'
      USING ERRCODE = '55000';
  END IF;
  BEGIN
    configured_roles := configured_roles_text::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      '0382 governed Apps persistence received a malformed application database role list'
      USING ERRCODE = '55000';
  END;
  IF jsonb_typeof(configured_roles) <> 'array'
    OR jsonb_array_length(configured_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(configured_roles) AS roles(value)
      WHERE jsonb_typeof(value) <> 'string'
        OR btrim(value #>> '{}') = ''
        OR octet_length(value #>> '{}') > 63
    )
    OR (
      SELECT count(*) FROM jsonb_array_elements_text(configured_roles)
    ) <> (
      SELECT count(DISTINCT value)
      FROM jsonb_array_elements_text(configured_roles) AS roles(value)
    )
  THEN
    RAISE EXCEPTION
      '0382 governed Apps persistence received an invalid application database role list'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0382 governed Apps persistence requires all configured OpenGeni application database sessions to be stopped'
      USING ERRCODE = '55000';
  END IF;
END
$governed_apps_writer_drain_before_lock$;

LOCK TABLE managed_accounts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE workspaces IN ACCESS EXCLUSIVE MODE;

DO $governed_apps_writer_drain_after_lock$
DECLARE
  configured_roles jsonb := current_setting(
    'opengeni.migration_application_roles', false
  )::jsonb;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_stat_activity activity
    JOIN jsonb_array_elements_text(configured_roles) roles(role_name)
      ON roles.role_name = activity.usename
    WHERE activity.datname = current_database()
      AND activity.pid <> pg_backend_pid()
  )
  THEN
    RAISE EXCEPTION
      '0382 governed Apps persistence observed a configured OpenGeni application database session after locking'
      USING ERRCODE = '55000';
  END IF;
END
$governed_apps_writer_drain_after_lock$;

CREATE TABLE apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 1,
  latest_source_revision_id uuid,
  latest_build_id uuid,
  active_release_id uuid,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT apps_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT apps_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT apps_workspace_slug_uq UNIQUE (workspace_id, slug),
  CONSTRAINT apps_slug_chk CHECK (
    length(slug) BETWEEN 1 AND 96
    AND slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
  ),
  CONSTRAINT apps_title_chk CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT apps_description_chk CHECK (description IS NULL OR length(description) <= 2000),
  CONSTRAINT apps_status_chk CHECK (status IN ('active', 'archived')),
  CONSTRAINT apps_version_chk CHECK (version > 0),
  CONSTRAINT apps_actor_chk CHECK (length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024)
);
CREATE INDEX apps_workspace_list_idx ON apps(workspace_id, updated_at DESC, id DESC);

CREATE TABLE app_source_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  revision bigint NOT NULL,
  format text NOT NULL DEFAULT 'portable_tar_v1',
  status text NOT NULL DEFAULT 'uploading',
  staging_object_key text NOT NULL,
  frozen_object_key text NOT NULL,
  frozen_version_token text,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  file_count integer,
  failure_code text,
  source_session_id uuid,
  source_turn_id uuid,
  source_attempt_id uuid,
  source_execution_generation integer,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CONSTRAINT app_source_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_source_revisions_app_fk FOREIGN KEY (workspace_id, app_id)
    REFERENCES apps(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT app_source_revisions_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_source_revisions_workspace_app_id_uq UNIQUE (workspace_id, app_id, id),
  CONSTRAINT app_source_revisions_app_revision_uq UNIQUE (workspace_id, app_id, revision),
  CONSTRAINT app_source_revisions_staging_object_uq UNIQUE (staging_object_key),
  CONSTRAINT app_source_revisions_frozen_object_uq UNIQUE (frozen_object_key),
  CONSTRAINT app_source_revisions_format_chk CHECK (format = 'portable_tar_v1'),
  CONSTRAINT app_source_revisions_status_chk CHECK (
    status IN ('uploading', 'verifying', 'ready', 'failed', 'expired', 'deleting', 'deleted')
  ),
  CONSTRAINT app_source_revisions_content_chk CHECK (
    content_sha256 ~ '^[0-9a-f]{64}$'
    AND size_bytes BETWEEN 1 AND 536870912
    AND length(staging_object_key) BETWEEN 1 AND 2048
    AND length(frozen_object_key) BETWEEN 1 AND 2048
    AND staging_object_key <> frozen_object_key
    AND position('/staging/' IN staging_object_key) > 0
    AND position('/frozen/' || content_sha256 || '.tar' IN frozen_object_key) > 0
  ),
  CONSTRAINT app_source_revisions_file_count_chk CHECK (
    file_count IS NULL OR file_count BETWEEN 1 AND 20000
  ),
  CONSTRAINT app_source_revisions_failure_chk CHECK (
    failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 256
  ),
  CONSTRAINT app_source_revisions_freeze_receipt_chk CHECK (
    frozen_version_token IS NULL OR length(frozen_version_token) BETWEEN 1 AND 2048
  ),
  CONSTRAINT app_source_revisions_provenance_chk CHECK (
    (source_session_id IS NULL AND source_turn_id IS NULL AND source_attempt_id IS NULL
      AND source_execution_generation IS NULL)
    OR
    (source_session_id IS NOT NULL AND source_turn_id IS NOT NULL AND source_attempt_id IS NOT NULL
      AND source_execution_generation > 0)
  ),
  CONSTRAINT app_source_revisions_state_chk CHECK (
    (status = 'ready' AND file_count IS NOT NULL AND failure_code IS NULL
      AND frozen_version_token IS NOT NULL AND verified_at IS NOT NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL AND verified_at IS NOT NULL)
    OR (status NOT IN ('ready', 'failed') AND verified_at IS NULL)
  )
);
CREATE INDEX app_source_revisions_app_created_idx
  ON app_source_revisions(workspace_id, app_id, created_at DESC, id DESC);
CREATE INDEX app_source_revisions_abandoned_upload_idx
  ON app_source_revisions(created_at, id)
  WHERE status IN ('uploading', 'verifying');

ALTER TABLE app_source_revisions
  ADD CONSTRAINT app_source_revisions_source_session_fk
    FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT app_source_revisions_source_turn_fk
    FOREIGN KEY (workspace_id, source_turn_id)
    REFERENCES session_turns(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT app_source_revisions_source_attempt_fk
    FOREIGN KEY (workspace_id, source_attempt_id)
    REFERENCES session_turn_attempts(workspace_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app_tool_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  revision bigint NOT NULL,
  catalog_digest text NOT NULL,
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_tool_policy_revisions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_tool_policy_revisions_app_fk FOREIGN KEY (workspace_id, app_id)
    REFERENCES apps(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT app_tool_policy_revisions_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_tool_policy_revisions_workspace_app_id_uq UNIQUE (workspace_id, app_id, id),
  CONSTRAINT app_tool_policy_revisions_app_revision_uq UNIQUE (workspace_id, app_id, revision),
  CONSTRAINT app_tool_policy_revisions_digest_chk CHECK (catalog_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT app_tool_policy_revisions_tools_chk CHECK (
    jsonb_typeof(allowed_tools) = 'array'
    AND jsonb_array_length(allowed_tools) <= 1000
  )
);

CREATE TABLE app_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  tool_policy_revision_id uuid NOT NULL,
  revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  manifest_object_key text NOT NULL,
  manifest_version_token text,
  manifest_sha256 text NOT NULL,
  manifest jsonb NOT NULL,
  entry_path text NOT NULL,
  file_count integer NOT NULL,
  total_bytes bigint NOT NULL,
  checks jsonb NOT NULL,
  receipt_digest text,
  failure_code text,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  CONSTRAINT app_builds_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_builds_source_revision_fk FOREIGN KEY (workspace_id, app_id, source_revision_id)
    REFERENCES app_source_revisions(workspace_id, app_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_builds_tool_policy_revision_fk
    FOREIGN KEY (workspace_id, app_id, tool_policy_revision_id)
    REFERENCES app_tool_policy_revisions(workspace_id, app_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_builds_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_builds_workspace_app_id_uq UNIQUE (workspace_id, app_id, id),
  CONSTRAINT app_builds_release_identity_uq
    UNIQUE (workspace_id, app_id, id, source_revision_id, tool_policy_revision_id),
  CONSTRAINT app_builds_app_revision_uq UNIQUE (workspace_id, app_id, revision),
  CONSTRAINT app_builds_status_chk CHECK (
    status IN ('queued', 'running', 'uploading', 'verifying', 'succeeded', 'failed', 'deleting', 'deleted')
  ),
  CONSTRAINT app_builds_manifest_chk CHECK (
    manifest_sha256 ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 4194304
    AND manifest->>'version' = 'opengeni.app-build.v1'
    AND jsonb_typeof(manifest->'files') = 'array'
    AND manifest->>'entryPath' = entry_path
    AND NULLIF(manifest->>'totalBytes', '')::bigint = total_bytes
    AND jsonb_array_length(manifest->'files') = file_count
    AND length(manifest_object_key) BETWEEN 1 AND 2048
    AND position('/frozen/' || manifest_sha256 || '/manifest.json' IN manifest_object_key) > 0
    AND length(entry_path) BETWEEN 1 AND 1024
    AND file_count BETWEEN 1 AND 2000
    AND total_bytes BETWEEN 0 AND 262144000
  ),
  CONSTRAINT app_builds_checks_chk CHECK (
    jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) BETWEEN 3 AND 32
  ),
  CONSTRAINT app_builds_receipt_chk CHECK (
    (receipt_digest IS NULL OR receipt_digest ~ '^[0-9a-f]{64}$')
    AND (manifest_version_token IS NULL OR length(manifest_version_token) BETWEEN 1 AND 2048)
  ),
  CONSTRAINT app_builds_failure_chk CHECK (
    failure_code IS NULL OR length(btrim(failure_code)) BETWEEN 1 AND 256
  ),
  CONSTRAINT app_builds_state_chk CHECK (
    (status = 'succeeded' AND receipt_digest IS NOT NULL AND manifest_version_token IS NOT NULL
      AND failure_code IS NULL AND verified_at IS NOT NULL)
    OR (status = 'failed' AND failure_code IS NOT NULL AND verified_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed') AND receipt_digest IS NULL
      AND failure_code IS NULL AND verified_at IS NULL)
  )
);
CREATE INDEX app_builds_app_created_idx
  ON app_builds(workspace_id, app_id, created_at DESC, id DESC);
CREATE INDEX app_builds_abandoned_upload_idx
  ON app_builds(created_at, id)
  WHERE status IN ('uploading', 'verifying');

CREATE TABLE app_build_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  build_id uuid NOT NULL,
  path text NOT NULL,
  content_type text NOT NULL,
  content_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  executable boolean NOT NULL DEFAULT false,
  staging_object_key text NOT NULL,
  frozen_object_key text NOT NULL,
  frozen_version_token text,
  created_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  CONSTRAINT app_build_files_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_build_files_build_fk FOREIGN KEY (workspace_id, app_id, build_id)
    REFERENCES app_builds(workspace_id, app_id, id) ON DELETE CASCADE,
  CONSTRAINT app_build_files_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_build_files_build_path_uq UNIQUE (workspace_id, app_id, build_id, path),
  CONSTRAINT app_build_files_staging_object_uq UNIQUE (staging_object_key),
  CONSTRAINT app_build_files_frozen_object_uq UNIQUE (frozen_object_key),
  CONSTRAINT app_build_files_path_chk CHECK (
    length(path) BETWEEN 1 AND 1024
    AND path !~ '(^/|/$|\\|[[:cntrl:]]|//|(^|/)(\.|\.\.)(/|$))'
  ),
  CONSTRAINT app_build_files_content_chk CHECK (
    length(btrim(content_type)) BETWEEN 1 AND 255
    AND content_sha256 ~ '^[0-9a-f]{64}$'
    AND size_bytes BETWEEN 0 AND 33554432
    AND length(staging_object_key) BETWEEN 1 AND 2048
    AND length(frozen_object_key) BETWEEN 1 AND 2048
    AND staging_object_key <> frozen_object_key
    AND position('/staging/' IN staging_object_key) > 0
    AND position('/frozen/' || content_sha256 || '/' IN frozen_object_key) > 0
  ),
  CONSTRAINT app_build_files_freeze_chk CHECK (
    (frozen_version_token IS NULL AND frozen_at IS NULL)
    OR (length(frozen_version_token) BETWEEN 1 AND 2048 AND frozen_at IS NOT NULL)
  )
);
CREATE INDEX app_build_files_build_idx
  ON app_build_files(workspace_id, app_id, build_id, id);

CREATE TABLE app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  build_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  tool_policy_revision_id uuid NOT NULL,
  revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'ready',
  manifest_sha256 text NOT NULL,
  entry_path text NOT NULL,
  file_count integer NOT NULL,
  total_bytes bigint NOT NULL,
  build_receipt_digest text NOT NULL,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_releases_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_releases_build_fk
    FOREIGN KEY (workspace_id, app_id, build_id, source_revision_id, tool_policy_revision_id)
    REFERENCES app_builds(workspace_id, app_id, id, source_revision_id, tool_policy_revision_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_releases_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_releases_workspace_app_id_uq UNIQUE (workspace_id, app_id, id),
  CONSTRAINT app_releases_app_revision_uq UNIQUE (workspace_id, app_id, revision),
  CONSTRAINT app_releases_build_uq UNIQUE (workspace_id, app_id, build_id),
  CONSTRAINT app_releases_status_chk CHECK (status IN ('ready', 'deleting', 'deleted')),
  CONSTRAINT app_releases_payload_chk CHECK (
    manifest_sha256 ~ '^[0-9a-f]{64}$'
    AND build_receipt_digest ~ '^[0-9a-f]{64}$'
    AND length(entry_path) BETWEEN 1 AND 1024
    AND file_count BETWEEN 1 AND 2000
    AND total_bytes BETWEEN 0 AND 262144000
  )
);
CREATE INDEX app_releases_app_created_idx
  ON app_releases(workspace_id, app_id, created_at DESC, id DESC);

ALTER TABLE apps
  ADD CONSTRAINT apps_latest_source_revision_fk
    FOREIGN KEY (workspace_id, id, latest_source_revision_id)
    REFERENCES app_source_revisions(workspace_id, app_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT apps_latest_build_fk
    FOREIGN KEY (workspace_id, id, latest_build_id)
    REFERENCES app_builds(workspace_id, app_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT apps_active_release_fk
    FOREIGN KEY (workspace_id, id, active_release_id)
    REFERENCES app_releases(workspace_id, app_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE app_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  spa_fallback boolean NOT NULL DEFAULT true,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT app_previews_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_previews_release_fk FOREIGN KEY (workspace_id, app_id, release_id)
    REFERENCES app_releases(workspace_id, app_id, id) ON DELETE CASCADE,
  CONSTRAINT app_previews_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_previews_workspace_target_id_uq UNIQUE (workspace_id, app_id, release_id, id),
  CONSTRAINT app_previews_status_chk CHECK (status IN ('active', 'expired', 'revoked')),
  CONSTRAINT app_previews_host_chk CHECK (
    hostname = lower(hostname) AND length(hostname) BETWEEN 1 AND 253
    AND hostname ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  ),
  CONSTRAINT app_previews_state_chk CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status IN ('expired', 'revoked') AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX app_previews_host_status_expiry_idx
  ON app_previews(hostname, status, expires_at);
CREATE INDEX app_previews_expiry_idx ON app_previews(status, expires_at);

CREATE TABLE app_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  previous_release_id uuid,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  spa_fallback boolean NOT NULL DEFAULT true,
  reason text NOT NULL,
  created_by_subject_id text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CONSTRAINT app_publications_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_publications_release_fk FOREIGN KEY (workspace_id, app_id, release_id)
    REFERENCES app_releases(workspace_id, app_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_publications_previous_release_fk FOREIGN KEY (workspace_id, app_id, previous_release_id)
    REFERENCES app_releases(workspace_id, app_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT app_publications_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_publications_workspace_target_id_uq UNIQUE (workspace_id, app_id, release_id, id),
  CONSTRAINT app_publications_status_chk CHECK (status IN ('active', 'retired')),
  CONSTRAINT app_publications_host_chk CHECK (
    hostname = lower(hostname) AND length(hostname) BETWEEN 1 AND 253
    AND hostname ~ '^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$'
  ),
  CONSTRAINT app_publications_audit_chk CHECK (
    length(btrim(reason)) BETWEEN 1 AND 4096
    AND length(btrim(created_by_subject_id)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT app_publications_state_chk CHECK (
    (status = 'active' AND retired_at IS NULL)
    OR (status = 'retired' AND retired_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX app_publications_active_app_uq
  ON app_publications(workspace_id, app_id) WHERE status = 'active';
CREATE UNIQUE INDEX app_publications_active_host_uq
  ON app_publications(hostname) WHERE status = 'active';

CREATE TABLE app_launches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  preview_id uuid,
  publication_id uuid,
  hostname text NOT NULL,
  nonce_sha256 text NOT NULL,
  authority_hash text,
  authority_epoch text,
  authority_generation text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_launches_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_launches_preview_fk FOREIGN KEY (workspace_id, app_id, release_id, preview_id)
    REFERENCES app_previews(workspace_id, app_id, release_id, id) ON DELETE CASCADE,
  CONSTRAINT app_launches_publication_fk
    FOREIGN KEY (workspace_id, app_id, release_id, publication_id)
    REFERENCES app_publications(workspace_id, app_id, release_id, id) ON DELETE CASCADE,
  CONSTRAINT app_launches_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_launches_workspace_release_id_uq UNIQUE (workspace_id, app_id, release_id, id),
  CONSTRAINT app_launches_nonce_sha256_uq UNIQUE (nonce_sha256),
  CONSTRAINT app_launches_target_chk CHECK (
    (preview_id IS NOT NULL AND publication_id IS NULL)
    OR (preview_id IS NULL AND publication_id IS NOT NULL)
  ),
  CONSTRAINT app_launches_nonce_chk CHECK (nonce_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT app_launches_authority_chk CHECK (
    length(authority_generation) BETWEEN 1 AND 256
    AND (
      (authority_hash IS NULL AND authority_epoch IS NULL)
      OR (authority_hash ~ '^[0-9a-f]{64}$' AND length(authority_epoch) BETWEEN 1 AND 256)
    )
  ),
  CONSTRAINT app_launches_status_chk CHECK (status IN ('active', 'revoked')),
  CONSTRAINT app_launches_state_chk CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX app_launches_expiry_idx ON app_launches(status, expires_at);

CREATE TABLE app_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  launch_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  tool_server_id text NOT NULL,
  tool_name text NOT NULL,
  catalog_digest text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  output jsonb,
  error jsonb,
  created_by_subject_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT app_tool_calls_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_tool_calls_launch_fk FOREIGN KEY (workspace_id, app_id, release_id, launch_id)
    REFERENCES app_launches(workspace_id, app_id, release_id, id) ON DELETE CASCADE,
  CONSTRAINT app_tool_calls_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_tool_calls_launch_operation_uq UNIQUE (workspace_id, launch_id, operation_id),
  CONSTRAINT app_tool_calls_identity_chk CHECK (
    octet_length(tool_server_id) BETWEEN 1 AND 256
    AND tool_server_id ~ '^[A-Za-z0-9_-]+$'
    AND length(tool_name) BETWEEN 1 AND 512
    AND tool_name !~ '[[:cntrl:]]'
    AND catalog_digest ~ '^[0-9a-f]{64}$'
    AND input_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT app_tool_calls_status_chk CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT app_tool_calls_state_chk CHECK (
    (status = 'pending' AND output IS NULL AND error IS NULL AND settled_at IS NULL)
    OR (status = 'succeeded' AND error IS NULL AND settled_at IS NOT NULL)
    OR (status = 'failed' AND output IS NULL AND error IS NOT NULL AND settled_at IS NOT NULL)
  )
);
CREATE INDEX app_tool_calls_launch_started_idx
  ON app_tool_calls(workspace_id, launch_id, started_at DESC, id DESC);

CREATE TABLE app_lifecycle_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_key text NOT NULL,
  command_kind text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  actor_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_lifecycle_operations_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_lifecycle_operations_workspace_operation_uq UNIQUE (workspace_id, operation_key),
  CONSTRAINT app_lifecycle_operations_key_chk CHECK (length(operation_key) BETWEEN 1 AND 200),
  CONSTRAINT app_lifecycle_operations_kind_chk CHECK (length(command_kind) BETWEEN 1 AND 64),
  CONSTRAINT app_lifecycle_operations_input_hash_chk CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT app_lifecycle_operations_actor_chk CHECK (
    length(btrim(actor_subject_id)) BETWEEN 1 AND 1024
  )
);

CREATE TABLE app_gc_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  operation_key text NOT NULL,
  input_hash text NOT NULL,
  lease_token uuid NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  object_keys jsonb NOT NULL,
  settlement_hash text,
  error_code text,
  actor_subject_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  CONSTRAINT app_gc_claims_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_gc_claims_app_fk FOREIGN KEY (workspace_id, app_id)
    REFERENCES apps(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT app_gc_claims_workspace_id_uq UNIQUE (workspace_id, id),
  CONSTRAINT app_gc_claims_workspace_app_id_uq UNIQUE (workspace_id, app_id, id),
  CONSTRAINT app_gc_claims_workspace_operation_uq UNIQUE (workspace_id, operation_key),
  CONSTRAINT app_gc_claims_status_chk CHECK (status IN ('claimed', 'completed', 'failed')),
  CONSTRAINT app_gc_claims_identity_chk CHECK (
    length(operation_key) BETWEEN 1 AND 200
    AND length(btrim(actor_subject_id)) BETWEEN 1 AND 1024
    AND (error_code IS NULL OR length(btrim(error_code)) BETWEEN 1 AND 256)
  ),
  CONSTRAINT app_gc_claims_keys_chk CHECK (
    jsonb_typeof(object_keys) = 'array' AND jsonb_array_length(object_keys) <= 100000
  ),
  CONSTRAINT app_gc_claims_hash_chk CHECK (
    input_hash ~ '^[0-9a-f]{64}$'
    AND (settlement_hash IS NULL OR settlement_hash ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT app_gc_claims_state_chk CHECK (
    (status = 'claimed' AND settlement_hash IS NULL AND settled_at IS NULL)
    OR (status = 'completed' AND settlement_hash IS NOT NULL AND error_code IS NULL AND settled_at IS NOT NULL)
    OR (status = 'failed' AND settlement_hash IS NOT NULL AND error_code IS NOT NULL AND settled_at IS NOT NULL)
  )
);

CREATE TABLE app_object_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  object_key text NOT NULL,
  provider_receipt text,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_object_tombstones_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_object_tombstones_claim_fk FOREIGN KEY (workspace_id, app_id, claim_id)
    REFERENCES app_gc_claims(workspace_id, app_id, id) ON DELETE CASCADE,
  CONSTRAINT app_object_tombstones_claim_object_uq UNIQUE (workspace_id, claim_id, object_key),
  CONSTRAINT app_object_tombstones_key_chk CHECK (length(object_key) BETWEEN 1 AND 2048)
);

-- Durable object deletion ownership. Deliberately no account/workspace/App FK:
-- these rows must survive a workspace cascade. Each key waits at least one
-- signed-upload TTL before it can be claimed, so a stale PUT cannot recreate a
-- staging object after successful cleanup.
CREATE TABLE app_object_cleanup_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  app_id uuid NOT NULL,
  object_key text NOT NULL,
  reason text NOT NULL,
  not_before timestamptz NOT NULL,
  claim_id uuid,
  claim_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_object_cleanup_outbox_object_uq UNIQUE (object_key),
  CONSTRAINT app_object_cleanup_outbox_reason_chk CHECK (
    reason IN ('archive', 'workspace_delete', 'abandoned_source', 'abandoned_build')
  ),
  CONSTRAINT app_object_cleanup_outbox_valid_chk CHECK (
    length(object_key) BETWEEN 1 AND 2048
    AND attempt_count >= 0
    AND ((claim_id IS NULL AND claim_until IS NULL)
      OR (claim_id IS NOT NULL AND claim_until IS NOT NULL))
    AND (last_error IS NULL OR length(last_error) <= 2000)
  )
);
CREATE INDEX app_object_cleanup_outbox_due_idx
  ON app_object_cleanup_outbox(next_attempt_at, not_before, claim_until, id);

-- A non-bypass table owner is still subject to FORCE RLS inside SECURITY
-- DEFINER routines. Mint a transaction-local, unforgeable maintenance token
-- only while an exact cleanup routine is scanning or settling Apps rows.
CREATE TABLE opengeni_private.app_maintenance_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT app_maintenance_capabilities_pk
    PRIMARY KEY (backend_pid, transaction_id, capability_id)
);
REVOKE ALL ON TABLE opengeni_private.app_maintenance_capabilities FROM PUBLIC;

CREATE FUNCTION opengeni_private.app_maintenance_capability_active()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
  SELECT EXISTS (
    SELECT 1
    FROM opengeni_private.app_maintenance_capabilities capability
    WHERE capability.backend_pid = pg_backend_pid()
      AND capability.transaction_id = pg_current_xact_id_if_assigned()
      AND capability.capability_id::text = nullif(
        current_setting('opengeni.app_maintenance_capability', true), ''
      )
  )
$body$;
REVOKE ALL ON FUNCTION opengeni_private.app_maintenance_capability_active() FROM PUBLIC;

-- Deliberately outside the tenant schema's table surface: the byte host gets
-- one exact host+digest+path resolver and no direct access to this mirror.
CREATE TABLE opengeni_private.app_host_routes (
  hostname text NOT NULL,
  nonce_sha256 text NOT NULL,
  app_id uuid NOT NULL,
  release_id uuid NOT NULL,
  preview_id uuid,
  publication_id uuid,
  launch_id uuid NOT NULL,
  entry_path text NOT NULL,
  spa_fallback boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  CONSTRAINT app_host_routes_pk PRIMARY KEY (hostname, nonce_sha256),
  CONSTRAINT app_host_routes_launch_uq UNIQUE (launch_id),
  CONSTRAINT app_host_routes_launch_fk FOREIGN KEY (launch_id)
    REFERENCES app_launches(id) ON DELETE CASCADE,
  CONSTRAINT app_host_routes_target_chk CHECK (
    (preview_id IS NOT NULL AND publication_id IS NULL)
    OR (preview_id IS NULL AND publication_id IS NOT NULL)
  )
);
REVOKE ALL ON TABLE opengeni_private.app_host_routes FROM PUBLIC;

CREATE TABLE opengeni_private.app_host_route_files (
  launch_id uuid NOT NULL,
  path text NOT NULL,
  object_key text NOT NULL,
  version_token text NOT NULL,
  CONSTRAINT app_host_route_files_pk PRIMARY KEY (launch_id, path),
  CONSTRAINT app_host_route_files_launch_fk FOREIGN KEY (launch_id)
    REFERENCES opengeni_private.app_host_routes(launch_id) ON DELETE CASCADE,
  CONSTRAINT app_host_route_files_object_chk CHECK (
    length(object_key) BETWEEN 1 AND 2048
    AND length(version_token) BETWEEN 1 AND 2048
  )
);
REVOKE ALL ON TABLE opengeni_private.app_host_route_files FROM PUBLIC;

DO $apps_force_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'apps', 'app_source_revisions', 'app_tool_policy_revisions', 'app_builds',
    'app_build_files', 'app_releases', 'app_previews', 'app_publications', 'app_launches',
    'app_tool_calls', 'app_lifecycle_operations', 'app_gc_claims', 'app_object_tombstones',
    'app_object_cleanup_outbox'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I USING '
      || '(opengeni_private.workspace_rls_visible(account_id, workspace_id) '
      || 'OR opengeni_private.app_maintenance_capability_active()) WITH CHECK '
      || '(opengeni_private.workspace_rls_visible(account_id, workspace_id) '
      || 'OR opengeni_private.app_maintenance_capability_active())',
      table_name
    );
  END LOOP;
END
$apps_force_rls$;

CREATE POLICY session_visibility_isolation
  ON app_source_revisions AS RESTRICTIVE
  FOR ALL
  USING (
    session_reference_visible(account_id, workspace_id, source_session_id)
    OR opengeni_private.app_maintenance_capability_active()
  )
  WITH CHECK (
    session_reference_visible(account_id, workspace_id, source_session_id)
    OR opengeni_private.app_maintenance_capability_active()
  );

CREATE FUNCTION opengeni_private.enforce_app_immutable_rows()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $body$
DECLARE workspace_missing boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.pg_trigger_depth() > 1 THEN
      EXECUTE pg_catalog.format(
        'SELECT NOT EXISTS (SELECT 1 FROM %I.workspaces WHERE id = $1)',
        TG_TABLE_SCHEMA
      ) INTO workspace_missing USING OLD.workspace_id;
      IF workspace_missing THEN RETURN OLD; END IF;
    END IF;
    RAISE EXCEPTION 'Immutable App history rows cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME IN ('app_tool_policy_revisions', 'app_releases') THEN
    RAISE EXCEPTION 'Immutable App history rows cannot be updated' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'app_source_revisions' THEN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.app_id IS DISTINCT FROM NEW.app_id
      OR OLD.revision IS DISTINCT FROM NEW.revision OR OLD.format IS DISTINCT FROM NEW.format
      OR OLD.staging_object_key IS DISTINCT FROM NEW.staging_object_key
      OR OLD.frozen_object_key IS DISTINCT FROM NEW.frozen_object_key
      OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
      OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
      OR OLD.source_session_id IS DISTINCT FROM NEW.source_session_id
      OR OLD.source_turn_id IS DISTINCT FROM NEW.source_turn_id
      OR OLD.source_attempt_id IS DISTINCT FROM NEW.source_attempt_id
      OR OLD.source_execution_generation IS DISTINCT FROM NEW.source_execution_generation
      OR OLD.created_by_subject_id IS DISTINCT FROM NEW.created_by_subject_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.status IN ('ready', 'failed', 'expired', 'deleting', 'deleted')
    THEN
      RAISE EXCEPTION 'Finalized App source revisions are immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'app_builds' THEN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.app_id IS DISTINCT FROM NEW.app_id
      OR OLD.source_revision_id IS DISTINCT FROM NEW.source_revision_id
      OR OLD.tool_policy_revision_id IS DISTINCT FROM NEW.tool_policy_revision_id
      OR OLD.revision IS DISTINCT FROM NEW.revision
      OR OLD.manifest_object_key IS DISTINCT FROM NEW.manifest_object_key
      OR OLD.manifest_sha256 IS DISTINCT FROM NEW.manifest_sha256
      OR OLD.manifest IS DISTINCT FROM NEW.manifest OR OLD.checks IS DISTINCT FROM NEW.checks
      OR OLD.entry_path IS DISTINCT FROM NEW.entry_path
      OR OLD.file_count IS DISTINCT FROM NEW.file_count
      OR OLD.total_bytes IS DISTINCT FROM NEW.total_bytes
      OR OLD.created_by_subject_id IS DISTINCT FROM NEW.created_by_subject_id
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.status IN ('succeeded', 'failed', 'deleting', 'deleted')
    THEN
      RAISE EXCEPTION 'Finalized App builds are immutable' USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'app_build_files' THEN
    IF OLD.id IS DISTINCT FROM NEW.id OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.app_id IS DISTINCT FROM NEW.app_id
      OR OLD.build_id IS DISTINCT FROM NEW.build_id OR OLD.path IS DISTINCT FROM NEW.path
      OR OLD.content_type IS DISTINCT FROM NEW.content_type
      OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
      OR OLD.size_bytes IS DISTINCT FROM NEW.size_bytes
      OR OLD.executable IS DISTINCT FROM NEW.executable
      OR OLD.staging_object_key IS DISTINCT FROM NEW.staging_object_key
      OR OLD.frozen_object_key IS DISTINCT FROM NEW.frozen_object_key
      OR OLD.created_at IS DISTINCT FROM NEW.created_at
      OR OLD.frozen_version_token IS NOT NULL
      OR NEW.frozen_version_token IS NULL OR NEW.frozen_at IS NULL
    THEN
      RAISE EXCEPTION 'Frozen App build file identities are immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$body$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_app_immutable_rows() FROM PUBLIC;

CREATE TRIGGER app_source_revisions_immutable_guard
BEFORE UPDATE OR DELETE ON app_source_revisions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_app_immutable_rows();
CREATE TRIGGER app_builds_immutable_guard
BEFORE UPDATE OR DELETE ON app_builds
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_app_immutable_rows();
CREATE TRIGGER app_build_files_immutable_guard
BEFORE UPDATE OR DELETE ON app_build_files
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_app_immutable_rows();
CREATE TRIGGER app_tool_policy_revisions_immutable_guard
BEFORE UPDATE OR DELETE ON app_tool_policy_revisions
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_app_immutable_rows();
CREATE TRIGGER app_releases_immutable_guard
BEFORE UPDATE OR DELETE ON app_releases
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_app_immutable_rows();

CREATE FUNCTION app_lifecycle_command_internal(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := NULLIF(p_input->>'accountId', '')::uuid;
  workspace_id_value uuid := NULLIF(p_input->>'workspaceId', '')::uuid;
  app_id_value uuid := NULLIF(p_input->>'appId', '')::uuid;
  action_value text := p_input->>'action';
  operation_key_value text := p_input->>'idempotencyKey';
  actor_subject_id_value text := p_input->>'actorSubjectId';
  caller_subject_id_value text := NULLIF(pg_catalog.current_setting('opengeni.subject_id', true), '');
  input_hash_value text;
  prior_operation app_lifecycle_operations%ROWTYPE;
  app_row apps%ROWTYPE;
  source_row app_source_revisions%ROWTYPE;
  policy_row app_tool_policy_revisions%ROWTYPE;
  build_row app_builds%ROWTYPE;
  release_row app_releases%ROWTYPE;
  preview_row app_previews%ROWTYPE;
  publication_row app_publications%ROWTYPE;
  result_value jsonb;
  expected_version_value bigint;
  next_revision bigint;
  affected_count integer;
  now_value timestamptz := clock_timestamp();
BEGIN
  IF account_id_value IS NULL OR workspace_id_value IS NULL OR action_value IS NULL
    OR operation_key_value IS NULL OR actor_subject_id_value IS NULL
    OR actor_subject_id_value IS DISTINCT FROM caller_subject_id_value
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR workspace_id_value IS DISTINCT FROM opengeni_private.current_workspace_id()
  THEN
    RAISE EXCEPTION 'App lifecycle requires exact tenant and actor authority'
      USING ERRCODE = '42501';
  END IF;
  IF length(operation_key_value) NOT BETWEEN 1 AND 200
    OR length(btrim(actor_subject_id_value)) NOT BETWEEN 1 AND 1024
  THEN
    RAISE EXCEPTION 'Invalid App lifecycle idempotency key or actor' USING ERRCODE = '22023';
  END IF;

  input_hash_value := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_input::text, 'UTF8')), 'hex'
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'app-lifecycle:' || workspace_id_value::text || ':' || operation_key_value, 0
  ));
  SELECT * INTO prior_operation
  FROM app_lifecycle_operations operation
  WHERE operation.workspace_id = workspace_id_value
    AND operation.operation_key = operation_key_value;
  IF FOUND THEN
    IF prior_operation.command_kind IS DISTINCT FROM action_value
      OR prior_operation.input_hash IS DISTINCT FROM input_hash_value
    THEN
      RAISE EXCEPTION 'App idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;
    RETURN prior_operation.result || jsonb_build_object('replayed', true);
  END IF;

  IF action_value = 'create_app' THEN
    app_id_value := COALESCE(app_id_value, gen_random_uuid());
    INSERT INTO apps (
      id, account_id, workspace_id, slug, title, description, created_by_subject_id
    ) VALUES (
      app_id_value, account_id_value, workspace_id_value, p_input->>'slug',
      p_input->>'title', p_input->>'description', actor_subject_id_value
    ) RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row)
    );

  ELSIF action_value = 'update_app' THEN
    expected_version_value := NULLIF(p_input->>'expectedVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' THEN
      RAISE EXCEPTION 'App is not active' USING ERRCODE = '55000';
    END IF;
    IF app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    UPDATE apps SET
      title = COALESCE(p_input->>'title', title),
      description = CASE WHEN p_input ? 'description' THEN p_input->>'description' ELSE description END,
      version = version + 1,
      updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row)
    );

  ELSIF action_value = 'create_tool_policy' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    IF jsonb_typeof(p_input->'allowedTools') IS DISTINCT FROM 'array'
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'allowedTools') allowed_tool
        WHERE jsonb_typeof(allowed_tool) IS DISTINCT FROM 'object'
          OR allowed_tool->>'serverId' IS NULL
          OR allowed_tool->>'toolName' IS NULL
          OR octet_length(allowed_tool->>'serverId') NOT BETWEEN 1 AND 256
          OR allowed_tool->>'serverId' !~ '^[A-Za-z0-9_-]+$'
          OR length(allowed_tool->>'toolName') NOT BETWEEN 1 AND 512
          OR allowed_tool->>'toolName' ~ '[[:cntrl:]]'
          OR allowed_tool - 'serverId' - 'toolName' <> '{}'::jsonb
      )
      OR (
        SELECT count(*) FROM jsonb_array_elements(p_input->'allowedTools') allowed_tool
      ) <> (
        SELECT count(DISTINCT (allowed_tool->>'serverId', allowed_tool->>'toolName'))
        FROM jsonb_array_elements(p_input->'allowedTools') allowed_tool
      )
    THEN
      RAISE EXCEPTION 'App tool policy contains invalid canonical identities'
        USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(max(revision), 0) + 1 INTO next_revision
    FROM app_tool_policy_revisions
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value;
    INSERT INTO app_tool_policy_revisions (
      id, account_id, workspace_id, app_id, revision, catalog_digest,
      allowed_tools, created_by_subject_id
    ) VALUES (
      COALESCE(NULLIF(p_input->>'toolPolicyRevisionId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, next_revision,
      p_input->>'catalogDigest', COALESCE(p_input->'allowedTools', '[]'::jsonb),
      actor_subject_id_value
    ) RETURNING * INTO policy_row;
    UPDATE apps SET version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'toolPolicy', to_jsonb(policy_row)
    );

  ELSIF action_value = 'begin_source_upload' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    SELECT COALESCE(max(revision), 0) + 1 INTO next_revision
    FROM app_source_revisions
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value;
    INSERT INTO app_source_revisions (
      id, account_id, workspace_id, app_id, revision, format,
      staging_object_key, frozen_object_key,
      content_sha256, size_bytes, source_session_id, source_turn_id,
      source_attempt_id, source_execution_generation, created_by_subject_id
    ) VALUES (
      COALESCE(NULLIF(p_input->>'sourceRevisionId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, next_revision,
      COALESCE(p_input->>'format', 'portable_tar_v1'), p_input->>'stagingObjectKey',
      p_input->>'frozenObjectKey',
      p_input->>'contentSha256', NULLIF(p_input->>'sizeBytes', '')::bigint,
      NULLIF(p_input->>'sourceSessionId', '')::uuid, NULLIF(p_input->>'sourceTurnId', '')::uuid,
      NULLIF(p_input->>'sourceAttemptId', '')::uuid,
      NULLIF(p_input->>'sourceExecutionGeneration', '')::integer, actor_subject_id_value
    ) RETURNING * INTO source_row;
    UPDATE apps SET latest_source_revision_id = source_row.id,
      version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'sourceRevision', to_jsonb(source_row)
    );

  ELSIF action_value IN ('complete_source_upload', 'fail_source_upload') THEN
    SELECT * INTO source_row FROM app_source_revisions
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'sourceRevisionId', '')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App source revision not found' USING ERRCODE = 'P0002'; END IF;
    IF source_row.status NOT IN ('uploading', 'verifying') THEN
      RAISE EXCEPTION 'App source upload is already settled' USING ERRCODE = '55000';
    END IF;
    IF source_row.content_sha256 IS DISTINCT FROM p_input->>'expectedContentSha256'
      OR source_row.size_bytes IS DISTINCT FROM NULLIF(p_input->>'expectedSizeBytes', '')::bigint
    THEN
      RAISE EXCEPTION 'App source upload identity changed' USING ERRCODE = '40001';
    END IF;
    UPDATE app_source_revisions SET
      status = CASE WHEN action_value = 'complete_source_upload' THEN 'ready' ELSE 'failed' END,
      frozen_version_token = CASE WHEN action_value = 'complete_source_upload'
        THEN p_input->>'frozenVersionToken' ELSE NULL END,
      file_count = CASE WHEN action_value = 'complete_source_upload'
        THEN NULLIF(p_input->>'fileCount', '')::integer ELSE NULL END,
      failure_code = CASE WHEN action_value = 'fail_source_upload'
        THEN p_input->>'failureCode' ELSE NULL END,
      verified_at = now_value
    WHERE workspace_id = workspace_id_value AND id = source_row.id
    RETURNING * INTO source_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'sourceRevision', to_jsonb(source_row)
    );

  ELSIF action_value = 'prepare_build' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO source_row FROM app_source_revisions
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'sourceRevisionId', '')::uuid AND status = 'ready';
    IF NOT FOUND THEN RAISE EXCEPTION 'Ready App source revision not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO policy_row FROM app_tool_policy_revisions
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'toolPolicyRevisionId', '')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'App tool policy revision not found' USING ERRCODE = 'P0002'; END IF;
    IF p_input->'manifest'->>'version' IS DISTINCT FROM 'opengeni.app-build.v1'
      OR p_input->'manifest'->>'entryPath' IS NULL
      OR jsonb_typeof(p_input->'manifest'->'files') IS DISTINCT FROM 'array'
      OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
        WHERE manifest_file->>'path' = p_input->'manifest'->>'entryPath'
      )
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
        WHERE manifest_file->>'path' IS NULL
          OR length(manifest_file->>'path') NOT BETWEEN 1 AND 1024
          OR manifest_file->>'path' ~ '(^/|/$|\\|[[:cntrl:]]|//|(^|/)(\.|\.\.)(/|$))'
          OR length(btrim(manifest_file->>'contentType')) NOT BETWEEN 1 AND 255
          OR manifest_file->>'contentSha256' !~ '^[0-9a-f]{64}$'
          OR NULLIF(manifest_file->>'sizeBytes', '')::bigint NOT BETWEEN 0 AND 33554432
      )
      OR (
        SELECT count(*) FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
      ) <> (
        SELECT count(DISTINCT manifest_file->>'path')
        FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
      )
      OR (
        SELECT COALESCE(sum((manifest_file->>'sizeBytes')::bigint), 0)
        FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
      ) IS DISTINCT FROM NULLIF(p_input->'manifest'->>'totalBytes', '')::bigint
      OR NOT (p_input->'checks' @> '[{"kind":"typecheck","status":"succeeded"}]'::jsonb)
      OR NOT (p_input->'checks' @> '[{"kind":"test","status":"succeeded"}]'::jsonb)
      OR NOT (p_input->'checks' @> '[{"kind":"build","status":"succeeded"}]'::jsonb)
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'checks') build_check
        WHERE build_check->>'kind' NOT IN ('typecheck', 'test', 'build')
          OR build_check->>'status' IS DISTINCT FROM 'succeeded'
          OR build_check->>'commandDigest' !~ '^[0-9a-f]{64}$'
          OR build_check->>'outputDigest' !~ '^[0-9a-f]{64}$'
          OR NULLIF(build_check->>'durationMs', '')::bigint < 0
      )
      OR jsonb_typeof(p_input->'fileObjects') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_input->'fileObjects')
        <> jsonb_array_length(p_input->'manifest'->'files')
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'fileObjects') file_object
        WHERE NULLIF(file_object->>'id', '')::uuid IS NULL
          OR length(file_object->>'stagingObjectKey') NOT BETWEEN 1 AND 2048
          OR length(file_object->>'frozenObjectKey') NOT BETWEEN 1 AND 2048
          OR file_object->>'stagingObjectKey' = file_object->>'frozenObjectKey'
          OR NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
            WHERE manifest_file->>'path' = file_object->>'path'
          )
      )
    THEN
      RAISE EXCEPTION 'App build manifest is invalid' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(max(revision), 0) + 1 INTO next_revision
    FROM app_builds WHERE workspace_id = workspace_id_value AND app_id = app_id_value;
    INSERT INTO app_builds (
      id, account_id, workspace_id, app_id, source_revision_id, tool_policy_revision_id,
      revision, manifest_object_key, manifest_sha256, manifest, entry_path, file_count,
      total_bytes, checks, created_by_subject_id
    ) VALUES (
      COALESCE(NULLIF(p_input->>'buildId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, source_row.id, policy_row.id,
      next_revision, p_input->>'manifestObjectKey', p_input->>'manifestSha256',
      p_input->'manifest', p_input->'manifest'->>'entryPath',
      jsonb_array_length(p_input->'manifest'->'files'),
      NULLIF(p_input->'manifest'->>'totalBytes', '')::bigint,
      p_input->'checks', actor_subject_id_value
    ) RETURNING * INTO build_row;
    INSERT INTO app_build_files (
      id, account_id, workspace_id, app_id, build_id, path, content_type,
      content_sha256, size_bytes, executable, staging_object_key, frozen_object_key
    )
    SELECT NULLIF(file_object->>'id', '')::uuid, account_id_value, workspace_id_value,
      app_id_value, build_row.id, manifest_file->>'path', manifest_file->>'contentType',
      manifest_file->>'contentSha256', (manifest_file->>'sizeBytes')::bigint,
      COALESCE((manifest_file->>'executable')::boolean, false),
      file_object->>'stagingObjectKey', file_object->>'frozenObjectKey'
    FROM jsonb_array_elements(p_input->'manifest'->'files') manifest_file
    JOIN jsonb_array_elements(p_input->'fileObjects') file_object
      ON file_object->>'path' = manifest_file->>'path';
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    IF affected_count <> build_row.file_count THEN
      RAISE EXCEPTION 'App build file identities are incomplete' USING ERRCODE = '22023';
    END IF;
    UPDATE apps SET latest_build_id = build_row.id,
      version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'build', to_jsonb(build_row)
    );

  ELSIF action_value IN ('complete_build', 'fail_build') THEN
    SELECT * INTO build_row FROM app_builds
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'buildId', '')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App build not found' USING ERRCODE = 'P0002'; END IF;
    IF build_row.status NOT IN ('queued', 'running', 'uploading', 'verifying') THEN
      RAISE EXCEPTION 'App build is already settled' USING ERRCODE = '55000';
    END IF;
    IF build_row.manifest_sha256 IS DISTINCT FROM p_input->>'expectedManifestSha256' THEN
      RAISE EXCEPTION 'App build manifest changed' USING ERRCODE = '40001';
    END IF;
    IF action_value = 'complete_build' AND (
      jsonb_typeof(p_input->'frozenFiles') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_input->'frozenFiles') <> build_row.file_count
      OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_input->'frozenFiles') frozen_file
        WHERE NULLIF(frozen_file->>'fileId', '')::uuid IS NULL
          OR length(frozen_file->>'frozenVersionToken') NOT BETWEEN 1 AND 2048
      )
    ) THEN
      RAISE EXCEPTION 'App build frozen file receipts are incomplete' USING ERRCODE = '22023';
    END IF;
    IF action_value = 'complete_build' THEN
      UPDATE app_build_files build_file SET
        frozen_version_token = frozen_file.value->>'frozenVersionToken', frozen_at = now_value
      FROM jsonb_array_elements(p_input->'frozenFiles') frozen_file(value)
      WHERE build_file.workspace_id = workspace_id_value
        AND build_file.app_id = app_id_value AND build_file.build_id = build_row.id
        AND build_file.id = NULLIF(frozen_file.value->>'fileId', '')::uuid
        AND build_file.frozen_version_token IS NULL;
      GET DIAGNOSTICS affected_count = ROW_COUNT;
      IF affected_count <> build_row.file_count THEN
        RAISE EXCEPTION 'App build file freeze identity changed' USING ERRCODE = '40001';
      END IF;
    END IF;
    UPDATE app_builds SET
      status = CASE WHEN action_value = 'complete_build' THEN 'succeeded' ELSE 'failed' END,
      manifest_version_token = CASE WHEN action_value = 'complete_build'
        THEN p_input->>'manifestVersionToken' ELSE NULL END,
      receipt_digest = CASE WHEN action_value = 'complete_build' THEN p_input->>'receiptDigest' ELSE NULL END,
      failure_code = CASE WHEN action_value = 'fail_build' THEN p_input->>'failureCode' ELSE NULL END,
      verified_at = now_value
    WHERE workspace_id = workspace_id_value AND id = build_row.id
    RETURNING * INTO build_row;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'build', to_jsonb(build_row)
    );

  ELSIF action_value = 'promote_build' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO build_row FROM app_builds
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'buildId', '')::uuid AND status = 'succeeded';
    IF NOT FOUND THEN RAISE EXCEPTION 'Succeeded App build not found' USING ERRCODE = 'P0002'; END IF;
    SELECT COALESCE(max(revision), 0) + 1 INTO next_revision
    FROM app_releases WHERE workspace_id = workspace_id_value AND app_id = app_id_value;
    INSERT INTO app_releases (
      id, account_id, workspace_id, app_id, build_id, source_revision_id,
      tool_policy_revision_id, revision, manifest_sha256, entry_path, file_count,
      total_bytes, build_receipt_digest, created_by_subject_id
    ) VALUES (
      COALESCE(NULLIF(p_input->>'releaseId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, build_row.id,
      build_row.source_revision_id, build_row.tool_policy_revision_id, next_revision,
      build_row.manifest_sha256, build_row.entry_path, build_row.file_count,
      build_row.total_bytes, build_row.receipt_digest, actor_subject_id_value
    ) RETURNING * INTO release_row;
    UPDATE apps SET version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'release', to_jsonb(release_row)
    );

  ELSIF action_value = 'create_preview' THEN
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value AND status = 'active'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active App not found' USING ERRCODE = 'P0002'; END IF;
    DELETE FROM opengeni_private.app_host_routes route WHERE route.preview_id IN (
      SELECT id FROM app_previews
      WHERE hostname = lower(p_input->>'hostname') AND status = 'active' AND expires_at <= now_value
    );
    UPDATE app_launches SET status = 'revoked', revoked_at = now_value
    WHERE preview_id IN (
      SELECT id FROM app_previews
      WHERE hostname = lower(p_input->>'hostname') AND status = 'active' AND expires_at <= now_value
    ) AND status = 'active';
    UPDATE app_previews SET status = 'expired', revoked_at = now_value
    WHERE hostname = lower(p_input->>'hostname') AND status = 'active' AND expires_at <= now_value;
    SELECT * INTO release_row FROM app_releases
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'releaseId', '')::uuid AND status = 'ready';
    IF NOT FOUND THEN RAISE EXCEPTION 'Ready App release not found' USING ERRCODE = 'P0002'; END IF;
    IF NULLIF(p_input->>'expiresAt', '')::timestamptz <= now_value
      OR NULLIF(p_input->>'expiresAt', '')::timestamptz > now_value + interval '24 hours'
    THEN
      RAISE EXCEPTION 'App preview expiry is invalid' USING ERRCODE = '22023';
    END IF;
    INSERT INTO app_previews (
      id, account_id, workspace_id, app_id, release_id, hostname, spa_fallback,
      created_by_subject_id, expires_at
    ) VALUES (
      COALESCE(NULLIF(p_input->>'previewId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, release_row.id,
      lower(p_input->>'hostname'), COALESCE((p_input->>'spaFallback')::boolean, true),
      actor_subject_id_value, NULLIF(p_input->>'expiresAt', '')::timestamptz
    ) RETURNING * INTO preview_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'preview', to_jsonb(preview_row)
    );

  ELSIF action_value = 'revoke_preview' THEN
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE app_previews SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'previewId', '')::uuid AND status = 'active'
    RETURNING * INTO preview_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active App preview not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE app_launches SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND preview_id = preview_row.id AND status = 'active';
    DELETE FROM opengeni_private.app_host_routes WHERE preview_id = preview_row.id;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'preview', to_jsonb(preview_row)
    );

  ELSIF action_value = 'publish_release' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    SELECT * INTO release_row FROM app_releases
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'releaseId', '')::uuid AND status = 'ready';
    IF NOT FOUND THEN RAISE EXCEPTION 'Ready App release not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE app_publications SET status = 'retired', retired_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active';
    UPDATE app_launches SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND publication_id IS NOT NULL AND status = 'active';
    DELETE FROM opengeni_private.app_host_routes route WHERE route.publication_id IN (
      SELECT id FROM app_publications
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'retired'
    );
    INSERT INTO app_publications (
      id, account_id, workspace_id, app_id, release_id, previous_release_id,
      hostname, spa_fallback, reason, created_by_subject_id
    ) VALUES (
      COALESCE(NULLIF(p_input->>'publicationId', '')::uuid, gen_random_uuid()),
      account_id_value, workspace_id_value, app_id_value, release_row.id,
      app_row.active_release_id, lower(p_input->>'hostname'),
      COALESCE((p_input->>'spaFallback')::boolean, true), p_input->>'reason',
      actor_subject_id_value
    ) RETURNING * INTO publication_row;
    UPDATE apps SET active_release_id = release_row.id,
      version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'release', to_jsonb(release_row), 'publication', to_jsonb(publication_row)
    );

  ELSIF action_value = 'unpublish_app' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' OR app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    UPDATE app_publications SET status = 'retired', retired_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active';
    UPDATE app_launches SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND publication_id IS NOT NULL AND status = 'active';
    DELETE FROM opengeni_private.app_host_routes route WHERE route.publication_id IN (
      SELECT id FROM app_publications
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'retired'
    );
    UPDATE apps SET active_release_id = NULL,
      version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'reason', p_input->>'reason'
    );

  ELSIF action_value = 'archive_app' THEN
    expected_version_value := NULLIF(p_input->>'expectedAppVersion', '')::bigint;
    SELECT * INTO app_row FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    IF app_row.status <> 'active' THEN
      RAISE EXCEPTION 'App is not active' USING ERRCODE = '55000';
    END IF;
    IF app_row.version <> expected_version_value THEN
      RAISE EXCEPTION 'App version conflict' USING ERRCODE = '40001';
    END IF;
    UPDATE app_publications SET status = 'retired', retired_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active';
    UPDATE app_previews SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active';
    UPDATE app_launches SET status = 'revoked', revoked_at = now_value
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active';
    DELETE FROM opengeni_private.app_host_routes WHERE app_id = app_id_value;
    INSERT INTO app_object_cleanup_outbox (
      account_id, workspace_id, app_id, object_key, reason,
      not_before, next_attempt_at
    )
    SELECT account_id_value, workspace_id_value, app_id_value,
      objects.object_key, 'archive', now_value + interval '15 minutes',
      now_value + interval '15 minutes'
    FROM (
      SELECT staging_object_key AS object_key FROM app_source_revisions
        WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      UNION SELECT frozen_object_key FROM app_source_revisions
        WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      UNION SELECT manifest_object_key FROM app_builds
        WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      UNION SELECT staging_object_key FROM app_build_files
        WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      UNION SELECT frozen_object_key FROM app_build_files
        WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    ) objects
    ON CONFLICT (object_key) DO NOTHING;
    UPDATE apps SET status = 'archived', active_release_id = NULL,
      version = version + 1, updated_at = now_value
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    RETURNING * INTO app_row;
    result_value := jsonb_build_object(
      'action', action_value, 'replayed', false, 'app', to_jsonb(app_row),
      'reason', p_input->>'reason'
    );

  ELSE
    RAISE EXCEPTION 'Unsupported App lifecycle action: %', action_value USING ERRCODE = '22023';
  END IF;

  INSERT INTO app_lifecycle_operations (
    account_id, workspace_id, operation_key, command_kind, input_hash,
    result, actor_subject_id
  ) VALUES (
    account_id_value, workspace_id_value, operation_key_value, action_value,
    input_hash_value, result_value, actor_subject_id_value
  );
  RETURN result_value;
END
$body$;

CREATE FUNCTION create_workspace_app_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"create_app"}'::jsonb) $body$;
CREATE FUNCTION update_workspace_app_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"update_app"}'::jsonb) $body$;
CREATE FUNCTION create_app_tool_policy_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"create_tool_policy"}'::jsonb) $body$;
CREATE FUNCTION begin_app_source_upload_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"begin_source_upload"}'::jsonb) $body$;
CREATE FUNCTION complete_app_source_upload_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"complete_source_upload"}'::jsonb) $body$;
CREATE FUNCTION fail_app_source_upload_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"fail_source_upload"}'::jsonb) $body$;
CREATE FUNCTION prepare_app_build_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"prepare_build"}'::jsonb) $body$;
CREATE FUNCTION complete_app_build_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"complete_build"}'::jsonb) $body$;
CREATE FUNCTION fail_app_build_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"fail_build"}'::jsonb) $body$;
CREATE FUNCTION promote_app_build_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"promote_build"}'::jsonb) $body$;
CREATE FUNCTION create_app_preview_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"create_preview"}'::jsonb) $body$;
CREATE FUNCTION revoke_app_preview_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"revoke_preview"}'::jsonb) $body$;
CREATE FUNCTION publish_app_release_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"publish_release"}'::jsonb) $body$;
CREATE FUNCTION unpublish_workspace_app_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"unpublish_app"}'::jsonb) $body$;
CREATE FUNCTION archive_workspace_app_command(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$ SELECT app_lifecycle_command_internal(p_input || '{"action":"archive_app"}'::jsonb) $body$;

CREATE FUNCTION app_launch_command(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := NULLIF(p_input->>'accountId', '')::uuid;
  workspace_id_value uuid := NULLIF(p_input->>'workspaceId', '')::uuid;
  app_id_value uuid := NULLIF(p_input->>'appId', '')::uuid;
  launch_id_value uuid := NULLIF(p_input->>'launchId', '')::uuid;
  actor_subject_id_value text := p_input->>'actorSubjectId';
  caller_subject_id_value text := NULLIF(pg_catalog.current_setting('opengeni.subject_id', true), '');
  app_row apps%ROWTYPE;
  build_row app_builds%ROWTYPE;
  release_row app_releases%ROWTYPE;
  preview_row app_previews%ROWTYPE;
  publication_row app_publications%ROWTYPE;
  launch_row app_launches%ROWTYPE;
  affected_count integer;
BEGIN
  IF account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR workspace_id_value IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR actor_subject_id_value IS NULL OR launch_id_value IS NULL
    OR actor_subject_id_value IS DISTINCT FROM caller_subject_id_value
    OR p_input->>'nonceSha256' !~ '^sha256:[0-9a-f]{64}$'
    OR p_input->>'authorityGeneration' IS NULL
    OR length(p_input->>'authorityGeneration') NOT BETWEEN 1 AND 256
    OR (
      (NULLIF(p_input->>'authorityHash', '') IS NULL)
        IS DISTINCT FROM (NULLIF(p_input->>'authorityEpoch', '') IS NULL)
    )
    OR (NULLIF(p_input->>'authorityHash', '') IS NOT NULL
      AND p_input->>'authorityHash' !~ '^[0-9a-f]{64}$')
  THEN
    RAISE EXCEPTION 'App launch requires exact tenant, actor, and digest authority'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'app-launch:' || workspace_id_value::text || ':' || launch_id_value::text, 0
  ));
  SELECT * INTO launch_row FROM app_launches
  WHERE workspace_id = workspace_id_value AND id = launch_id_value;
  IF FOUND THEN
    IF launch_row.app_id IS DISTINCT FROM app_id_value
      OR launch_row.nonce_sha256 IS DISTINCT FROM p_input->>'nonceSha256'
      OR launch_row.authority_hash IS DISTINCT FROM NULLIF(p_input->>'authorityHash', '')
      OR launch_row.authority_epoch IS DISTINCT FROM NULLIF(p_input->>'authorityEpoch', '')
      OR launch_row.authority_generation IS DISTINCT FROM p_input->>'authorityGeneration'
    THEN
      RAISE EXCEPTION 'App launch id was reused with different input' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('replayed', true, 'launch', to_jsonb(launch_row));
  END IF;
  SELECT * INTO app_row FROM apps
  WHERE workspace_id = workspace_id_value AND id = app_id_value AND status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active App not found' USING ERRCODE = 'P0002'; END IF;

  IF NULLIF(p_input->>'previewId', '') IS NOT NULL THEN
    SELECT * INTO preview_row FROM app_previews
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = NULLIF(p_input->>'previewId', '')::uuid AND status = 'active'
      AND expires_at > clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'Active App preview not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO release_row FROM app_releases
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = preview_row.release_id AND status = 'ready';
  ELSE
    SELECT * INTO publication_row FROM app_publications
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value AND status = 'active'
      AND release_id = COALESCE(NULLIF(p_input->>'releaseId', '')::uuid, app_row.active_release_id);
    IF NOT FOUND THEN RAISE EXCEPTION 'Published App release not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO release_row FROM app_releases
    WHERE workspace_id = workspace_id_value AND app_id = app_id_value
      AND id = publication_row.release_id AND status = 'ready';
  END IF;
  IF release_row.id IS NULL THEN RAISE EXCEPTION 'Ready App release not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO build_row FROM app_builds
  WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    AND id = release_row.build_id AND status = 'succeeded';
  IF NOT FOUND THEN RAISE EXCEPTION 'Succeeded App build not found' USING ERRCODE = 'P0002'; END IF;

  -- Keep the heavy host-route mirror bounded without deleting compact launch
  -- audit rows. Every fresh launch creates one route, while this reaps up to
  -- eight expired routes in the same workspace under SKIP LOCKED coordination.
  WITH expired_launches AS (
    SELECT candidate.id
    FROM app_launches candidate
    WHERE candidate.workspace_id = workspace_id_value
      AND candidate.status = 'active'
      AND candidate.expires_at <= clock_timestamp()
    ORDER BY candidate.expires_at, candidate.id
    FOR UPDATE SKIP LOCKED
    LIMIT 8
  ), revoked_launches AS (
    UPDATE app_launches expired
    SET status = 'revoked', revoked_at = clock_timestamp()
    FROM expired_launches candidate
    WHERE expired.id = candidate.id
    RETURNING expired.id
  )
  DELETE FROM opengeni_private.app_host_routes route
  USING revoked_launches revoked
  WHERE route.launch_id = revoked.id;

  INSERT INTO app_launches (
    id, account_id, workspace_id, app_id, release_id, preview_id, publication_id,
    hostname, nonce_sha256, authority_hash, authority_epoch, authority_generation,
    expires_at, created_by_subject_id
  ) VALUES (
    launch_id_value, account_id_value, workspace_id_value, app_id_value, release_row.id,
    preview_row.id, publication_row.id, COALESCE(preview_row.hostname, publication_row.hostname),
    p_input->>'nonceSha256', NULLIF(p_input->>'authorityHash', ''),
    NULLIF(p_input->>'authorityEpoch', ''), p_input->>'authorityGeneration', LEAST(
      NULLIF(p_input->>'expiresAt', '')::timestamptz,
      COALESCE(preview_row.expires_at, 'infinity'::timestamptz)
    ), actor_subject_id_value
  ) RETURNING * INTO launch_row;
  IF launch_row.expires_at <= clock_timestamp()
    OR launch_row.expires_at > clock_timestamp() + interval '15 minutes'
  THEN
    RAISE EXCEPTION 'App launch expiry is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO opengeni_private.app_host_routes (
    hostname, nonce_sha256, app_id, release_id, preview_id, publication_id, launch_id,
    entry_path, spa_fallback, expires_at
  ) VALUES (
    launch_row.hostname, launch_row.nonce_sha256, app_id_value, release_row.id,
    preview_row.id, publication_row.id, launch_row.id, release_row.entry_path,
    COALESCE(preview_row.spa_fallback, publication_row.spa_fallback),
    launch_row.expires_at
  );
  INSERT INTO opengeni_private.app_host_route_files (
    launch_id, path, object_key, version_token
  )
  SELECT launch_row.id, build_file.path, build_file.frozen_object_key,
    build_file.frozen_version_token
  FROM app_build_files build_file
  WHERE build_file.workspace_id = workspace_id_value
    AND build_file.app_id = app_id_value AND build_file.build_id = build_row.id
    AND build_file.frozen_version_token IS NOT NULL;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count <> build_row.file_count THEN
    RAISE EXCEPTION 'App release has incomplete frozen files' USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object('replayed', false, 'launch', to_jsonb(launch_row));
END
$body$;

CREATE FUNCTION app_tool_call_command(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := NULLIF(p_input->>'accountId', '')::uuid;
  workspace_id_value uuid := NULLIF(p_input->>'workspaceId', '')::uuid;
  app_id_value uuid := NULLIF(p_input->>'appId', '')::uuid;
  release_id_value uuid := NULLIF(p_input->>'releaseId', '')::uuid;
  launch_id_value uuid := NULLIF(p_input->>'launchId', '')::uuid;
  operation_id_value uuid := NULLIF(p_input->>'operationId', '')::uuid;
  action_value text := p_input->>'action';
  actor_subject_id_value text := p_input->>'actorSubjectId';
  caller_subject_id_value text := NULLIF(pg_catalog.current_setting('opengeni.subject_id', true), '');
  input_hash_value text;
  launch_row app_launches%ROWTYPE;
  policy_row app_tool_policy_revisions%ROWTYPE;
  call_row app_tool_calls%ROWTYPE;
BEGIN
  IF account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR workspace_id_value IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR actor_subject_id_value IS NULL
    OR actor_subject_id_value IS DISTINCT FROM caller_subject_id_value
    OR app_id_value IS NULL OR release_id_value IS NULL
    OR launch_id_value IS NULL OR operation_id_value IS NULL
    OR p_input->>'launchNonceSha256' !~ '^sha256:[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'App tool call requires exact tenant authority' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'app-tool-call:' || workspace_id_value::text || ':' || launch_id_value::text
      || ':' || operation_id_value::text, 0
  ));
  SELECT * INTO call_row FROM app_tool_calls
  WHERE workspace_id = workspace_id_value AND launch_id = launch_id_value
    AND operation_id = operation_id_value FOR UPDATE;
  IF call_row.id IS NOT NULL
    AND call_row.created_by_subject_id IS DISTINCT FROM actor_subject_id_value
  THEN
    RAISE EXCEPTION 'App tool operation belongs to another actor' USING ERRCODE = '42501';
  END IF;
  IF call_row.id IS NOT NULL THEN
    SELECT * INTO launch_row FROM app_launches
    WHERE workspace_id = workspace_id_value AND id = call_row.launch_id
      AND app_id = app_id_value AND release_id = release_id_value
      AND nonce_sha256 = p_input->>'launchNonceSha256'
      AND created_by_subject_id = actor_subject_id_value
      AND authority_hash IS NOT DISTINCT FROM NULLIF(p_input->>'authorityHash', '')
      AND authority_epoch IS NOT DISTINCT FROM NULLIF(p_input->>'authorityEpoch', '')
      AND authority_generation = p_input->>'authorityGeneration';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'App launch actor generation changed' USING ERRCODE = '42501';
    END IF;
    IF action_value = 'begin' AND call_row.status = 'pending'
      AND (launch_row.status <> 'active' OR launch_row.expires_at <= clock_timestamp())
    THEN
      RAISE EXCEPTION 'Active App launch not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  IF action_value = 'begin' THEN
    input_hash_value := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(COALESCE(p_input->'input', '{}'::jsonb)::text, 'UTF8')),
      'hex'
    );
    IF call_row.id IS NOT NULL THEN
      IF call_row.tool_server_id IS DISTINCT FROM p_input->'identity'->>'serverId'
        OR call_row.tool_name IS DISTINCT FROM p_input->'identity'->>'toolName'
        OR call_row.catalog_digest IS DISTINCT FROM p_input->>'catalogDigest'
        OR call_row.input_hash IS DISTINCT FROM input_hash_value
      THEN
        RAISE EXCEPTION 'App tool operation was reused with different input' USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('replayed', true, 'toolCall', to_jsonb(call_row));
    END IF;
    PERFORM 1 FROM apps
    WHERE workspace_id = workspace_id_value AND id = app_id_value
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'App not found' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO launch_row FROM app_launches
    WHERE workspace_id = workspace_id_value AND id = launch_id_value
      AND app_id = app_id_value AND release_id = release_id_value
      AND nonce_sha256 = p_input->>'launchNonceSha256'
      AND status = 'active' AND expires_at > clock_timestamp()
      AND created_by_subject_id = actor_subject_id_value
      AND authority_hash IS NOT DISTINCT FROM NULLIF(p_input->>'authorityHash', '')
      AND authority_epoch IS NOT DISTINCT FROM NULLIF(p_input->>'authorityEpoch', '')
      AND authority_generation = p_input->>'authorityGeneration'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active App launch not found' USING ERRCODE = 'P0002'; END IF;
    SELECT app_policy.* INTO policy_row
    FROM app_releases app_release
    JOIN app_tool_policy_revisions app_policy
      ON app_policy.workspace_id = app_release.workspace_id
      AND app_policy.app_id = app_release.app_id
      AND app_policy.id = app_release.tool_policy_revision_id
    WHERE app_release.workspace_id = workspace_id_value
      AND app_release.id = launch_row.release_id;
    IF NOT FOUND OR policy_row.catalog_digest IS DISTINCT FROM p_input->>'catalogDigest'
      OR NOT policy_row.allowed_tools @> jsonb_build_array(p_input->'identity')
    THEN
      RAISE EXCEPTION 'App tool is not authorized by the release policy' USING ERRCODE = '42501';
    END IF;
    INSERT INTO app_tool_calls (
      account_id, workspace_id, app_id, release_id, launch_id, operation_id,
      tool_server_id, tool_name, catalog_digest, input_hash, created_by_subject_id
    ) VALUES (
      account_id_value, workspace_id_value, launch_row.app_id, launch_row.release_id,
      launch_row.id, operation_id_value, p_input->'identity'->>'serverId',
      p_input->'identity'->>'toolName', p_input->>'catalogDigest',
      input_hash_value, p_input->>'actorSubjectId'
    ) RETURNING * INTO call_row;
    RETURN jsonb_build_object('replayed', false, 'toolCall', to_jsonb(call_row));

  ELSIF action_value = 'settle' THEN
    IF call_row.id IS NULL THEN
      RAISE EXCEPTION 'App tool call not found' USING ERRCODE = 'P0002';
    END IF;
    IF call_row.status <> 'pending' THEN
      IF call_row.status IS DISTINCT FROM p_input->>'status'
        OR call_row.output IS DISTINCT FROM (
          CASE WHEN p_input->>'status' = 'succeeded' THEN p_input->'output' ELSE NULL END
        )
        OR call_row.error IS DISTINCT FROM (
          CASE WHEN p_input->>'status' = 'failed' THEN p_input->'error' ELSE NULL END
        )
      THEN
        RAISE EXCEPTION 'App tool operation settlement was reused with different output'
          USING ERRCODE = '22023';
      END IF;
      RETURN jsonb_build_object('replayed', true, 'toolCall', to_jsonb(call_row));
    END IF;
    IF p_input->>'status' NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'Invalid App tool call settlement' USING ERRCODE = '22023';
    END IF;
    UPDATE app_tool_calls SET
      status = p_input->>'status',
      output = CASE WHEN p_input->>'status' = 'succeeded' THEN p_input->'output' ELSE NULL END,
      error = CASE WHEN p_input->>'status' = 'failed' THEN p_input->'error' ELSE NULL END,
      settled_at = clock_timestamp()
    WHERE workspace_id = workspace_id_value AND id = call_row.id
    RETURNING * INTO call_row;
    RETURN jsonb_build_object('replayed', false, 'toolCall', to_jsonb(call_row));
  END IF;
  RAISE EXCEPTION 'Unsupported App tool call action: %', action_value USING ERRCODE = '22023';
END
$body$;

CREATE FUNCTION claim_archived_app_gc_command(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := NULLIF(p_input->>'accountId', '')::uuid;
  workspace_id_value uuid := NULLIF(p_input->>'workspaceId', '')::uuid;
  app_id_value uuid := NULLIF(p_input->>'appId', '')::uuid;
  actor_subject_id_value text := p_input->>'actorSubjectId';
  operation_key_value text := p_input->>'idempotencyKey';
  input_hash_value text := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_input::text, 'UTF8')), 'hex'
  );
  claim_row app_gc_claims%ROWTYPE;
  object_keys_value jsonb;
BEGIN
  IF account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR workspace_id_value IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR actor_subject_id_value IS DISTINCT FROM
      NULLIF(pg_catalog.current_setting('opengeni.subject_id', true), '')
    OR operation_key_value IS NULL
  THEN
    RAISE EXCEPTION 'App GC claim requires exact tenant and subject authority'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'app-gc:' || workspace_id_value::text || ':' || app_id_value::text, 0
  ));
  SELECT * INTO claim_row FROM app_gc_claims
  WHERE workspace_id = workspace_id_value AND operation_key = operation_key_value;
  IF FOUND THEN
    IF claim_row.input_hash IS DISTINCT FROM input_hash_value THEN
      RAISE EXCEPTION 'App GC idempotency key was reused with different input'
        USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('claim', to_jsonb(claim_row), 'replayed', true);
  END IF;
  PERFORM 1 FROM apps
  WHERE workspace_id = workspace_id_value AND id = app_id_value AND status = 'archived'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Archived App not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM app_publications WHERE workspace_id = workspace_id_value
      AND app_id = app_id_value AND status = 'active')
    OR EXISTS (SELECT 1 FROM app_previews WHERE workspace_id = workspace_id_value
      AND app_id = app_id_value AND status = 'active')
    OR EXISTS (SELECT 1 FROM app_launches WHERE workspace_id = workspace_id_value
      AND app_id = app_id_value AND status = 'active')
    OR EXISTS (SELECT 1 FROM opengeni_private.app_host_routes WHERE app_id = app_id_value)
  THEN
    RAISE EXCEPTION 'Archived App still has live serving references' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM app_gc_claims WHERE workspace_id = workspace_id_value
      AND app_id = app_id_value AND status = 'claimed' AND lease_expires_at > clock_timestamp())
  THEN
    RAISE EXCEPTION 'Archived App already has an active GC claim' USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(objects.object_key) ORDER BY objects.object_key), '[]'::jsonb)
  INTO object_keys_value
  FROM (
    SELECT staging_object_key AS object_key FROM app_source_revisions
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    UNION SELECT frozen_object_key FROM app_source_revisions
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    UNION SELECT manifest_object_key FROM app_builds
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    UNION SELECT staging_object_key FROM app_build_files
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value
    UNION SELECT frozen_object_key FROM app_build_files
      WHERE workspace_id = workspace_id_value AND app_id = app_id_value
  ) objects
  WHERE NOT EXISTS (
    SELECT 1 FROM app_object_tombstones tombstone
    WHERE tombstone.workspace_id = workspace_id_value
      AND tombstone.app_id = app_id_value AND tombstone.object_key = objects.object_key
  );
  INSERT INTO app_gc_claims (
    account_id, workspace_id, app_id, operation_key, input_hash, lease_token,
    object_keys, actor_subject_id, lease_expires_at
  ) VALUES (
    account_id_value, workspace_id_value, app_id_value, operation_key_value,
    input_hash_value, COALESCE(NULLIF(p_input->>'leaseToken', '')::uuid, gen_random_uuid()),
    object_keys_value, actor_subject_id_value, clock_timestamp() + interval '15 minutes'
  ) RETURNING * INTO claim_row;
  RETURN jsonb_build_object('claim', to_jsonb(claim_row), 'replayed', false);
END
$body$;

CREATE FUNCTION settle_archived_app_gc_command(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  account_id_value uuid := NULLIF(p_input->>'accountId', '')::uuid;
  workspace_id_value uuid := NULLIF(p_input->>'workspaceId', '')::uuid;
  actor_subject_id_value text := p_input->>'actorSubjectId';
  claim_id_value uuid := NULLIF(p_input->>'claimId', '')::uuid;
  settlement_hash_value text := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(p_input::text, 'UTF8')), 'hex'
  );
  claim_row app_gc_claims%ROWTYPE;
BEGIN
  IF account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR workspace_id_value IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR actor_subject_id_value IS DISTINCT FROM
      NULLIF(pg_catalog.current_setting('opengeni.subject_id', true), '')
  THEN
    RAISE EXCEPTION 'App GC settlement requires exact tenant and subject authority'
      USING ERRCODE = '42501';
  END IF;
  SELECT * INTO claim_row FROM app_gc_claims
  WHERE workspace_id = workspace_id_value AND id = claim_id_value FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'App GC claim not found' USING ERRCODE = 'P0002'; END IF;
  IF claim_row.lease_token IS DISTINCT FROM NULLIF(p_input->>'leaseToken', '')::uuid THEN
    RAISE EXCEPTION 'App GC lease token mismatch' USING ERRCODE = '42501';
  END IF;
  IF claim_row.actor_subject_id IS DISTINCT FROM actor_subject_id_value THEN
    RAISE EXCEPTION 'App GC claimant subject mismatch' USING ERRCODE = '42501';
  END IF;
  IF claim_row.status = 'claimed' AND claim_row.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'App GC claim lease expired' USING ERRCODE = '55000';
  END IF;
  IF claim_row.status <> 'claimed' THEN
    IF claim_row.settlement_hash IS DISTINCT FROM settlement_hash_value THEN
      RAISE EXCEPTION 'App GC settlement was replayed with different input' USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('claim', to_jsonb(claim_row), 'replayed', true);
  END IF;
  IF p_input->>'status' = 'completed' THEN
    IF jsonb_typeof(p_input->'deletedObjects') IS DISTINCT FROM 'array'
      OR (SELECT jsonb_agg(to_jsonb(value) ORDER BY value) FROM jsonb_array_elements_text(claim_row.object_keys))
        IS DISTINCT FROM
        (SELECT jsonb_agg(to_jsonb(deleted_object->>'objectKey') ORDER BY deleted_object->>'objectKey')
          FROM jsonb_array_elements(p_input->'deletedObjects') deleted_object)
    THEN
      RAISE EXCEPTION 'App GC completion does not cover the exact claim' USING ERRCODE = '22023';
    END IF;
    INSERT INTO app_object_tombstones (
      account_id, workspace_id, app_id, claim_id, object_key, provider_receipt
    )
    SELECT claim_row.account_id, claim_row.workspace_id, claim_row.app_id, claim_row.id,
      deleted_object->>'objectKey', deleted_object->>'providerReceipt'
    FROM jsonb_array_elements(p_input->'deletedObjects') deleted_object;
    UPDATE app_gc_claims SET status = 'completed', settlement_hash = settlement_hash_value,
      settled_at = clock_timestamp()
    WHERE workspace_id = workspace_id_value AND id = claim_row.id RETURNING * INTO claim_row;
  ELSIF p_input->>'status' = 'failed' THEN
    UPDATE app_gc_claims SET status = 'failed', settlement_hash = settlement_hash_value,
      error_code = p_input->>'errorCode', settled_at = clock_timestamp()
    WHERE workspace_id = workspace_id_value AND id = claim_row.id RETURNING * INTO claim_row;
  ELSE
    RAISE EXCEPTION 'Invalid App GC settlement status' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('claim', to_jsonb(claim_row), 'replayed', false);
END
$body$;

CREATE FUNCTION reap_abandoned_app_uploads_command(p_limit integer DEFAULT 32)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  limit_value integer := greatest(1, least(coalesce(p_limit, 32), 100));
  enqueued_count integer := 0;
  affected_count integer := 0;
  now_value timestamptz := clock_timestamp();
  capability_id_value uuid := gen_random_uuid();
  prior_capability_value text := current_setting('opengeni.app_maintenance_capability', true);
BEGIN
  INSERT INTO opengeni_private.app_maintenance_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), capability_id_value);
  PERFORM set_config(
    'opengeni.app_maintenance_capability', capability_id_value::text, true
  );

  WITH stale_sources AS (
    SELECT source.id
    FROM app_source_revisions source
    WHERE source.status IN ('uploading', 'verifying')
      AND source.created_at <= now_value - interval '24 hours'
    ORDER BY source.created_at, source.id
    FOR UPDATE SKIP LOCKED
    LIMIT limit_value
  ), expired_sources AS (
    UPDATE app_source_revisions source
    SET status = 'expired', failure_code = 'upload_expired'
    FROM stale_sources stale
    WHERE source.id = stale.id
    RETURNING source.account_id, source.workspace_id, source.app_id,
      source.staging_object_key, source.frozen_object_key
  ), objects AS (
    SELECT account_id, workspace_id, app_id, staging_object_key AS object_key
      FROM expired_sources
    UNION
    SELECT account_id, workspace_id, app_id, frozen_object_key
      FROM expired_sources
  )
  INSERT INTO app_object_cleanup_outbox (
    account_id, workspace_id, app_id, object_key, reason,
    not_before, next_attempt_at
  )
  SELECT account_id, workspace_id, app_id, object_key, 'abandoned_source',
    now_value + interval '15 minutes', now_value + interval '15 minutes'
  FROM objects
  ON CONFLICT (object_key) DO NOTHING;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  enqueued_count := enqueued_count + affected_count;

  WITH stale_builds AS (
    SELECT build.id
    FROM app_builds build
    WHERE build.status IN ('uploading', 'verifying')
      AND build.created_at <= now_value - interval '24 hours'
    ORDER BY build.created_at, build.id
    FOR UPDATE SKIP LOCKED
    LIMIT limit_value
  ), expired_builds AS (
    UPDATE app_builds build
    SET status = 'failed', failure_code = 'upload_expired', verified_at = now_value
    FROM stale_builds stale
    WHERE build.id = stale.id
    RETURNING build.id, build.account_id, build.workspace_id, build.app_id,
      build.manifest_object_key
  ), objects AS (
    SELECT account_id, workspace_id, app_id, manifest_object_key AS object_key
      FROM expired_builds
    UNION
    SELECT expired.account_id, expired.workspace_id, expired.app_id,
      file.staging_object_key
    FROM expired_builds expired
    JOIN app_build_files file ON file.build_id = expired.id
    UNION
    SELECT expired.account_id, expired.workspace_id, expired.app_id,
      file.frozen_object_key
    FROM expired_builds expired
    JOIN app_build_files file ON file.build_id = expired.id
  )
  INSERT INTO app_object_cleanup_outbox (
    account_id, workspace_id, app_id, object_key, reason,
    not_before, next_attempt_at
  )
  SELECT account_id, workspace_id, app_id, object_key, 'abandoned_build',
    now_value + interval '15 minutes', now_value + interval '15 minutes'
  FROM objects
  ON CONFLICT (object_key) DO NOTHING;
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  DELETE FROM opengeni_private.app_maintenance_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = capability_id_value;
  PERFORM set_config(
    'opengeni.app_maintenance_capability', coalesce(prior_capability_value, ''), true
  );
  RETURN enqueued_count + affected_count;
END
$body$;

CREATE FUNCTION claim_app_object_cleanups(
  p_claim_id uuid,
  p_limit integer DEFAULT 32,
  p_claim_seconds integer DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  account_id uuid,
  workspace_id uuid,
  app_id uuid,
  object_key text,
  reason text,
  attempt_count integer
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  capability_id_value uuid := gen_random_uuid();
  prior_capability_value text := current_setting('opengeni.app_maintenance_capability', true);
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'App object cleanup claim id is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.app_maintenance_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), capability_id_value);
  PERFORM set_config(
    'opengeni.app_maintenance_capability', capability_id_value::text, true
  );
  RETURN QUERY
    WITH due AS (
      SELECT cleanup.id
      FROM app_object_cleanup_outbox cleanup
      WHERE cleanup.not_before <= clock_timestamp()
        AND cleanup.next_attempt_at <= clock_timestamp()
        AND (cleanup.claim_until IS NULL OR cleanup.claim_until <= clock_timestamp())
      ORDER BY cleanup.next_attempt_at, cleanup.not_before, cleanup.created_at, cleanup.id
      FOR UPDATE SKIP LOCKED
      LIMIT greatest(1, least(coalesce(p_limit, 32), 100))
    )
    UPDATE app_object_cleanup_outbox cleanup
    SET claim_id = p_claim_id,
      claim_until = clock_timestamp() + make_interval(
        secs => greatest(5, least(coalesce(p_claim_seconds, 15), 300))
      ),
      attempt_count = cleanup.attempt_count + 1,
      updated_at = clock_timestamp()
    FROM due
    WHERE cleanup.id = due.id
    RETURNING cleanup.id, cleanup.account_id, cleanup.workspace_id, cleanup.app_id,
      cleanup.object_key, cleanup.reason, cleanup.attempt_count;
  DELETE FROM opengeni_private.app_maintenance_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = capability_id_value;
  PERFORM set_config(
    'opengeni.app_maintenance_capability', coalesce(prior_capability_value, ''), true
  );
END
$body$;

CREATE FUNCTION settle_app_object_cleanup(
  p_id uuid,
  p_claim_id uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT
AS $body$
DECLARE
  affected_count bigint := 0;
  settled_value boolean := false;
  capability_id_value uuid := gen_random_uuid();
  prior_capability_value text := current_setting('opengeni.app_maintenance_capability', true);
BEGIN
  IF p_id IS NULL OR p_claim_id IS NULL THEN
    RAISE EXCEPTION 'App object cleanup id and claim id are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.app_maintenance_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), capability_id_value);
  PERFORM set_config(
    'opengeni.app_maintenance_capability', capability_id_value::text, true
  );
  IF p_error IS NULL THEN
    DELETE FROM app_object_cleanup_outbox cleanup
    WHERE cleanup.id = p_id AND cleanup.claim_id = p_claim_id;
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    settled_value := affected_count = 1;
  ELSE
    UPDATE app_object_cleanup_outbox cleanup
    SET claim_id = NULL,
      claim_until = NULL,
      next_attempt_at = clock_timestamp() + make_interval(
        secs => least(
          300,
          greatest(1, power(2, least(cleanup.attempt_count - 1, 8))::integer)
        )
      ),
      last_error = left(p_error, 2000),
      updated_at = clock_timestamp()
    WHERE cleanup.id = p_id AND cleanup.claim_id = p_claim_id;
    GET DIAGNOSTICS affected_count = ROW_COUNT;
    settled_value := affected_count = 1;
  END IF;
  DELETE FROM opengeni_private.app_maintenance_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = capability_id_value;
  PERFORM set_config(
    'opengeni.app_maintenance_capability', coalesce(prior_capability_value, ''), true
  );
  RETURN settled_value;
END
$body$;

CREATE FUNCTION opengeni_private.resolve_app_host_launch(
  p_hostname text,
  p_launch_token_digest text,
  p_requested_path text
)
RETURNS TABLE (
  app_id uuid,
  release_id uuid,
  launch_id uuid,
  preview_id uuid,
  publication_id uuid,
  expires_at timestamptz,
  spa_fallback boolean,
  requested_path text,
  requested_object_key text,
  requested_version_token text,
  entry_path text,
  entry_object_key text,
  entry_version_token text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = opengeni_private, pg_catalog
AS $body$
  SELECT route.app_id, route.release_id, route.launch_id, route.preview_id,
    route.publication_id, route.expires_at, route.spa_fallback,
    requested.path, requested.object_key, requested.version_token,
    route.entry_path, entry_file.object_key, entry_file.version_token
  FROM app_host_routes route
  JOIN app_host_route_files entry_file
    ON entry_file.launch_id = route.launch_id AND entry_file.path = route.entry_path
  LEFT JOIN app_host_route_files requested
    ON requested.launch_id = route.launch_id AND requested.path = p_requested_path
  WHERE route.hostname = lower(p_hostname)
    AND route.nonce_sha256 = p_launch_token_digest
    AND p_launch_token_digest ~ '^sha256:[0-9a-f]{64}$'
    AND route.expires_at > clock_timestamp()
  LIMIT 1
$body$;

REVOKE ALL ON FUNCTION app_lifecycle_command_internal(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_launch_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_tool_call_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_archived_app_gc_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_archived_app_gc_command(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION reap_abandoned_app_uploads_command(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION claim_app_object_cleanups(uuid, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION settle_app_object_cleanup(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.app_maintenance_capability_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.resolve_app_host_launch(text, text, text) FROM PUBLIC;

DO $apps_pin_and_grant$
DECLARE
  data_schema text := current_schema();
  application_role text;
  routine_signature text;
BEGIN
  FOREACH routine_signature IN ARRAY ARRAY[
    'create_workspace_app_command(jsonb)', 'update_workspace_app_command(jsonb)',
    'create_app_tool_policy_command(jsonb)', 'begin_app_source_upload_command(jsonb)',
    'complete_app_source_upload_command(jsonb)', 'fail_app_source_upload_command(jsonb)',
    'prepare_app_build_command(jsonb)', 'complete_app_build_command(jsonb)',
    'fail_app_build_command(jsonb)', 'promote_app_build_command(jsonb)',
    'create_app_preview_command(jsonb)', 'revoke_app_preview_command(jsonb)',
    'publish_app_release_command(jsonb)', 'unpublish_workspace_app_command(jsonb)',
    'archive_workspace_app_command(jsonb)', 'app_launch_command(jsonb)',
    'app_tool_call_command(jsonb)', 'claim_archived_app_gc_command(jsonb)',
    'settle_archived_app_gc_command(jsonb)',
    'reap_abandoned_app_uploads_command(integer)',
    'claim_app_object_cleanups(uuid, integer, integer)',
    'settle_app_object_cleanup(uuid, uuid, text)'
  ] LOOP
    EXECUTE format('ALTER FUNCTION %I.%s SET search_path = pg_catalog, %I, pg_temp', data_schema, routine_signature, data_schema);
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%s FROM PUBLIC', data_schema, routine_signature);
  END LOOP;
  EXECUTE format('ALTER FUNCTION %I.app_lifecycle_command_internal(jsonb) SET search_path = pg_catalog, %I, pg_temp', data_schema, data_schema);

  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION
    SELECT 'opengeni_app' WHERE EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app'
    )
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.apps, %I.app_source_revisions, '
      || '%I.app_tool_policy_revisions, %I.app_builds, %I.app_build_files, %I.app_releases, '
      || '%I.app_previews, %I.app_publications, %I.app_launches, %I.app_tool_calls, '
      || '%I.app_lifecycle_operations, %I.app_gc_claims, %I.app_object_tombstones, '
      || '%I.app_object_cleanup_outbox FROM %I',
      data_schema, data_schema, data_schema, data_schema, data_schema, data_schema,
      data_schema, data_schema, data_schema, data_schema, data_schema, data_schema,
      data_schema, data_schema, application_role
    );
    EXECUTE format(
      'GRANT SELECT ON TABLE %I.apps, %I.app_source_revisions, '
      || '%I.app_tool_policy_revisions, %I.app_builds, %I.app_build_files, %I.app_releases, '
      || '%I.app_previews, %I.app_publications, %I.app_launches, %I.app_tool_calls TO %I',
      data_schema, data_schema, data_schema, data_schema, data_schema, data_schema,
      data_schema, data_schema, data_schema, data_schema, application_role
    );
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.app_object_cleanup_outbox TO %I',
      data_schema, application_role
    );
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE opengeni_private.app_maintenance_capabilities FROM %I',
      application_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.app_maintenance_capability_active() TO %I',
      application_role
    );
    FOREACH routine_signature IN ARRAY ARRAY[
      'create_workspace_app_command(jsonb)', 'update_workspace_app_command(jsonb)',
      'create_app_tool_policy_command(jsonb)', 'begin_app_source_upload_command(jsonb)',
      'complete_app_source_upload_command(jsonb)', 'fail_app_source_upload_command(jsonb)',
      'prepare_app_build_command(jsonb)', 'complete_app_build_command(jsonb)',
      'fail_app_build_command(jsonb)', 'promote_app_build_command(jsonb)',
      'create_app_preview_command(jsonb)', 'revoke_app_preview_command(jsonb)',
      'publish_app_release_command(jsonb)', 'unpublish_workspace_app_command(jsonb)',
      'archive_workspace_app_command(jsonb)', 'app_launch_command(jsonb)',
      'app_tool_call_command(jsonb)', 'claim_archived_app_gc_command(jsonb)',
      'settle_archived_app_gc_command(jsonb)',
      'reap_abandoned_app_uploads_command(integer)',
      'claim_app_object_cleanups(uuid, integer, integer)',
      'settle_app_object_cleanup(uuid, uuid, text)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%s TO %I', data_schema, routine_signature, application_role);
    END LOOP;
    EXECUTE format('GRANT USAGE ON SCHEMA opengeni_private TO %I', application_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION opengeni_private.resolve_app_host_launch(text, text, text) TO %I', application_role);
  END LOOP;
END
$apps_pin_and_grant$;

COMMENT ON FUNCTION opengeni_private.resolve_app_host_launch(text, text, text) IS
  'Exact host plus launch-token digest plus normalized path lookup for immutable App serving. Returns no tenant ids, source archive, manifest, actor, or tool-call content.';