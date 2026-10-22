-- deployment-mode: rolling
-- Admin access for agent sessions. An organization first allows it (off by
-- default); then an owner or admin can give one of their own sessions admin
-- access, and the agent in that session can do what that person can manage
-- across the organization. The row records who gave it; removing the row ends
-- it. Every use re-checks the allowance, the row and the person's live role,
-- so turning either off, or the person losing their role, takes effect on the
-- next call. Old releases never read these tables.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "organization_agent_admin_access" (
  "account_id" uuid PRIMARY KEY REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "session_admin_access_allowed" boolean NOT NULL DEFAULT false,
  "updated_by_subject_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "session_admin_access" (
  "session_id" uuid PRIMARY KEY REFERENCES "sessions"("id") ON DELETE CASCADE,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "granted_by_subject_id" text NOT NULL
    CHECK (char_length("granted_by_subject_id") BETWEEN 1 AND 1024),
  "granted_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "session_admin_access_account_idx" ON "session_admin_access" ("account_id");

ALTER TABLE "organization_agent_admin_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_agent_admin_access" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_admin_access" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_admin_access" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "organization_agent_admin_access" FROM PUBLIC;
REVOKE ALL ON "session_admin_access" FROM PUBLIC;
-- Readable within the organization; writes additionally pass the in-person
-- organization-administrator checks in the application before they get here.
CREATE POLICY organization_agent_admin_access_account ON "organization_agent_admin_access"
  USING ("account_id" = opengeni_private.current_account_id())
  WITH CHECK ("account_id" = opengeni_private.current_account_id());
CREATE POLICY session_admin_access_account ON "session_admin_access"
  USING ("account_id" = opengeni_private.current_account_id())
  WITH CHECK ("account_id" = opengeni_private.current_account_id());

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.organization_agent_admin_access TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.session_admin_access TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
