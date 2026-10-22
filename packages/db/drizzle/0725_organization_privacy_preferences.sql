-- deployment-mode: rolling
-- Two privacy choices an organization's owners and admins make under Security:
-- whether new chats and schedules start as Workspace or Only me, and whether
-- admins see that other people's Only me schedules exist (owner, how often,
-- cost, and pause). A missing row means Workspace and on, the behavior before
-- this table existed. Deployment limits can only narrow these in the
-- application. Old releases never read this table.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "organization_privacy_preferences" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "default_visibility" text NOT NULL DEFAULT 'workspace_shared',
  "admins_see_private_schedules" boolean NOT NULL DEFAULT true,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_privacy_preferences_default_visibility_chk
    CHECK ("default_visibility" IN ('workspace_shared', 'user_private'))
);

ALTER TABLE "organization_privacy_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_privacy_preferences" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "organization_privacy_preferences" FROM PUBLIC;
-- Readable within the organization (members need the default); writes
-- additionally pass the organization-administrator check in the application.
CREATE POLICY organization_privacy_preferences_account ON "organization_privacy_preferences"
  USING ("account_id" = opengeni_private.current_account_id())
  WITH CHECK ("account_id" = opengeni_private.current_account_id());

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.organization_privacy_preferences TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
