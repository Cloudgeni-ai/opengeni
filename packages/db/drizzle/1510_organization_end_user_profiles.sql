-- deployment-mode: rolling
-- End-user display details for Console (docs/opengeni-console.md). The
-- embedding product's backend may send a display name and an email with the
-- end user it acts as (`asUser(id, { displayName, email })`, an external
-- member add, or the session proxy). Console shows them beside the product's
-- own id and searches them.
--
-- organization_end_user_profiles: one row per external user subject
-- (`external_user:<identity>`), keyed exactly like organization_end_user_labels
-- (1377), which Console already reads without the runtime reading
-- external_identities. The latest value sent wins; a field the product leaves
-- out keeps its stored value. Display only, never authority.
-- Offboarding the end user deletes their row (personal data), so the runtime
-- also holds DELETE.
--
-- Why a table of its own: external_identities is an authority table (lifecycle
-- gated RLS and statement triggers that re-arm usage allowances on UPDATE), and
-- organization_end_user_labels is append-only for the runtime (SELECT, INSERT);
-- giving it UPDATE would differ from the runtime posture the previous release
-- checks during a rolling deploy.
--
-- Rolling: a new table the previous release never reads or writes. Nullable
-- columns, no backfill.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_end_user_profiles (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  display_name text,
  email text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id),
  CONSTRAINT organization_end_user_profiles_bounds_check
    CHECK (subject_id LIKE 'external_user:%' AND length(subject_id) <= 512
      AND (display_name IS NULL OR length(display_name) BETWEEN 1 AND 256)
      AND (email IS NULL OR length(email) BETWEEN 1 AND 320))
);
COMMENT ON TABLE organization_end_user_profiles IS 'Display name and email the embedding product sent for an external user subject; display only, never authority.';

ALTER TABLE organization_end_user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_end_user_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_end_user_profiles FROM PUBLIC;
CREATE POLICY account_isolation ON organization_end_user_profiles
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $opengeni_end_user_profile_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    -- Exact grants, whatever the owner's default privileges gave the runtime.
    REVOKE ALL ON organization_end_user_profiles FROM opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_end_user_profiles TO opengeni_app;
  END IF;
END
$opengeni_end_user_profile_grants$;
