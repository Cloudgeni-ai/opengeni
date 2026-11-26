-- deployment-mode: rolling
-- New nullable session provenance and a standalone, subject-scoped RLS table.
-- Older binaries can still mint sessions; the API recognizes their stored device
-- label for compatibility. No new callable SECURITY DEFINER routine is needed:
-- the runtime can perform scoped DML without elevation during a mixed rollout.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE auth_sessions ADD COLUMN native_app_platform text;
-- All pre-existing values are NULL. Check new writes without scanning the table.
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_native_app_platform_check
  CHECK (native_app_platform IN ('ios', 'android', 'macos', 'windows', 'linux', 'office')) NOT VALID;

CREATE TABLE ai_processing_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  disclosure_version text NOT NULL CHECK (disclosure_version ~ '^[a-f0-9]{64}$'),
  disclosure jsonb NOT NULL CHECK (jsonb_typeof(disclosure) = 'object'),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'macos', 'windows', 'linux', 'office', 'web')),
  withdrawn_at timestamptz,
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= granted_at)
);
CREATE INDEX ai_processing_consents_user_idx ON ai_processing_consents (auth_user_id);
CREATE UNIQUE INDEX ai_processing_consents_active_user_idx ON ai_processing_consents (auth_user_id)
  WHERE withdrawn_at IS NULL;

ALTER TABLE ai_processing_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_processing_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_processing_consents_self ON ai_processing_consents
  USING (('user:' || auth_user_id) = opengeni_private.current_subject_id())
  WITH CHECK (('user:' || auth_user_id) = opengeni_private.current_subject_id());

REVOKE ALL ON TABLE ai_processing_consents FROM PUBLIC;
DO $$
DECLARE application_role text;
BEGIN
  FOR application_role IN
    SELECT r.rolname
    FROM jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_roles r ON r.rolname = configured.value
    UNION SELECT 'opengeni_app' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE ai_processing_consents TO %I', application_role);
  END LOOP;
END $$;
