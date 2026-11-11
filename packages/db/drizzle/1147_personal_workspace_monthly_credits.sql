-- deployment-mode: rolling
-- online-safety-exception: constraint-validation: the table holds one row per organization and the new column is null in every row, so validation is a trivial scan under the five second lock timeout
-- An organization can limit what each person spends from its credits in their
-- own Personal workspace each month (docs/design/ownership-and-reach.md: the
-- organization is the only wallet; an optional per-person cap on
-- Personal-workspace spending, off by default).
--
-- Null means no limit, so every existing organization keeps exactly today's
-- behavior. The limit applies to a Personal workspace that has no budget of
-- its own, over the same calendar-month (UTC) counters every workspace already
-- keeps. Work paid by the person's own model plans or keys spends no credits
-- and never counts.
--
-- The previous release names its columns when it reads and writes these
-- preferences, so it ignores the new column and leaves it unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_privacy_preferences
  ADD COLUMN personal_workspace_monthly_credits bigint;

ALTER TABLE organization_privacy_preferences
  ADD CONSTRAINT organization_privacy_preferences_personal_monthly_credits_chk
  CHECK (personal_workspace_monthly_credits IS NULL
    OR personal_workspace_monthly_credits BETWEEN 0 AND 9007199254740991) NOT VALID;

ALTER TABLE organization_privacy_preferences
  VALIDATE CONSTRAINT organization_privacy_preferences_personal_monthly_credits_chk;

COMMENT ON COLUMN organization_privacy_preferences.personal_workspace_monthly_credits IS 'The most each person may spend from the organization''s credits in their own Personal workspace per calendar month (UTC), in USD micros. Null: no limit. A Personal workspace''s own budget wins.';
