-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS organization_user_resource_authorities_subscription_resource_uq
  ON organization_user_resource_authorities (
    id, account_id, organization_membership_id, resource_kind, resource_id
  );
