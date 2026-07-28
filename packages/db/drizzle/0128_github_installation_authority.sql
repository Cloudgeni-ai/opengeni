-- deployment-mode: rolling

ALTER TABLE "github_installations"
  ADD COLUMN IF NOT EXISTS "github_account_id" bigint,
  ADD COLUMN IF NOT EXISTS "github_actor_id" bigint,
  ADD COLUMN IF NOT EXISTS "github_actor_login" text,
  ADD COLUMN IF NOT EXISTS "authority_kind" text,
  ADD COLUMN IF NOT EXISTS "authority_checked_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "authority_expires_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "authority_nonce" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'github_installations_authority_kind_check'
      AND conrelid = 'github_installations'::regclass
  ) THEN
    ALTER TABLE "github_installations"
      ADD CONSTRAINT "github_installations_authority_kind_check"
      CHECK (
        (
          "github_account_id" IS NULL
          AND "github_actor_id" IS NULL
          AND "github_actor_login" IS NULL
          AND "authority_kind" IS NULL
          AND "authority_checked_at" IS NULL
          AND "authority_expires_at" IS NULL
          AND "authority_nonce" IS NULL
        )
        OR (
          "github_account_id" IS NOT NULL
          AND "github_account_id" > 0
          AND "github_actor_id" IS NOT NULL
          AND "github_actor_id" > 0
          AND "github_actor_login" IS NOT NULL
          AND length("github_actor_login") > 0
          AND "account_login" IS NOT NULL
          AND length("account_login") > 0
          AND "account_type" IS NOT NULL
          AND "linked_by_subject_id" IS NOT NULL
          AND length("linked_by_subject_id") > 0
          AND "authority_kind" IS NOT NULL
          AND "authority_checked_at" IS NOT NULL
          AND "authority_expires_at" IS NOT NULL
          AND "authority_checked_at" < "authority_expires_at"
          AND "authority_expires_at" <= "authority_checked_at" + interval '10 minutes'
          AND "authority_nonce" IS NOT NULL
          AND length("authority_nonce") > 0
          AND "repository_scope" = 'selected'
          AND (
            (
              "authority_kind" = 'personal_owner'
              AND "account_type" = 'User'
              AND "github_actor_id" = "github_account_id"
            )
            OR (
              "authority_kind" = 'organization_owner'
              AND "account_type" = 'Organization'
            )
          )
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_authority_nonce_uq"
  ON "github_installations" ("authority_nonce")
  WHERE "authority_nonce" IS NOT NULL;