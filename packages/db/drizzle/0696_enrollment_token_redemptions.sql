-- deployment-mode: rolling
-- Single-use Connected Machine enroll tokens. An `oget_` token is a signed,
-- stateless grant that used to connect any number of machines until it
-- expired an hour later. New tokens carry a unique `jti`; the exchange records
-- it here in the same transaction that creates the enrollment, so one token
-- connects one machine. The same machine (same public key) may repeat the
-- exchange while it is still enrolled, which keeps a lost response or a re-run
-- install command working; a machine removed since needs a new token.
-- Tokens minted before this release have no jti and are never recorded.
-- Old releases never read or write the table, so a mixed fleet only delays
-- single-use enforcement until every API replica runs this release.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "enrollment_token_redemptions" (
  "token_id" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- The redeeming machine's identity; a repeat exchange must present it.
  "pubkey" text NOT NULL,
  -- ON DELETE SET NULL so removing the machine never erases the redemption.
  "enrollment_id" uuid REFERENCES "enrollments"("id") ON DELETE SET NULL,
  -- The token's own expiry; rows are pruned a day after it.
  "expires_at" timestamptz NOT NULL,
  "redeemed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "enrollment_token_redemptions_token_id_check"
    CHECK ("token_id" ~ '^[A-Za-z0-9_-]{16,128}$')
);

CREATE INDEX "enrollment_token_redemptions_workspace_expires_idx"
  ON "enrollment_token_redemptions" ("workspace_id", "expires_at");
-- Supports ON DELETE SET NULL when a machine's enrollment row is deleted.
CREATE INDEX "enrollment_token_redemptions_enrollment_idx"
  ON "enrollment_token_redemptions" ("enrollment_id")
  WHERE "enrollment_id" IS NOT NULL;

ALTER TABLE "enrollment_token_redemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "enrollment_token_redemptions" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON "enrollment_token_redemptions" FROM PUBLIC;
-- The exchange runs scoped to the workspace the signed token names, like the
-- enrollment it creates.
CREATE POLICY workspace_isolation ON "enrollment_token_redemptions"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.enrollment_token_redemptions TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;
