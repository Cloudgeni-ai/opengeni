-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=5s statement-timeout=60s
-- online-safety-exception: unbatched-data: each transaction projects at most 500 memberships selected by LIMIT, committing before the next batch.
-- Required before the new notification writers start; not post-release.
-- The runner opens the existing migration-owner membership lifecycle policy
-- for this file only. Each batch scopes the account GUC to one organization.
-- FORCE RLS and runtime grants never change.
-- SHARE locks serialize with revocation/role changes: the 1241 trigger removes
-- or replaces the projection after an update, or its committed change is seen.
WITH next_account AS MATERIALIZED (
  SELECT membership.account_id
  FROM organization_memberships membership
  LEFT JOIN billing_credit_notification_recipients recipient
    ON recipient.account_id=membership.account_id AND recipient.subject_id=membership.subject_id
  WHERE membership.status='active' AND membership.revoked_at IS NULL
    AND membership.role IN ('owner','admin') AND membership.subject_id LIKE 'user:%'
    AND (recipient.membership_id IS DISTINCT FROM membership.id
      OR recipient.personal_workspace_id IS DISTINCT FROM membership.personal_workspace_id)
  ORDER BY membership.account_id
  LIMIT 1
), account_scope AS MATERIALIZED (
  SELECT set_config('opengeni.account_id',account_id::text,true)::uuid AS account_id FROM next_account
), target AS MATERIALIZED (
  SELECT membership.account_id,membership.subject_id,membership.id,membership.personal_workspace_id
  FROM organization_memberships membership
  JOIN account_scope ON account_scope.account_id=membership.account_id
  LEFT JOIN billing_credit_notification_recipients recipient
    ON recipient.account_id=membership.account_id AND recipient.subject_id=membership.subject_id
  WHERE membership.status='active' AND membership.revoked_at IS NULL
    AND membership.role IN ('owner','admin') AND membership.subject_id LIKE 'user:%'
    AND (recipient.membership_id IS DISTINCT FROM membership.id
      OR recipient.personal_workspace_id IS DISTINCT FROM membership.personal_workspace_id)
  ORDER BY membership.id
  LIMIT 500
  FOR SHARE OF membership
), inserted AS (
  INSERT INTO billing_credit_notification_recipients(account_id,subject_id,membership_id,personal_workspace_id)
  SELECT account_id,subject_id,id,personal_workspace_id FROM target
  ON CONFLICT (account_id,subject_id) DO UPDATE
    SET membership_id=excluded.membership_id,personal_workspace_id=excluded.personal_workspace_id
  RETURNING membership_id
)
SELECT membership_id FROM inserted
UNION ALL
-- If revocation won every selected row lock, take a fresh snapshot for other
-- organizations instead of treating this transient empty write as convergence.
SELECT account_id FROM account_scope WHERE NOT EXISTS (SELECT 1 FROM inserted)
