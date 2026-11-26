-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS organization_invite_receipt_target_email_idx
ON organization_membership_operation_receipts ((result->>'targetEmail'))
WHERE action = 'invite';
