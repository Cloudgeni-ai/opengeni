-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_verifications_subject_lookup_idx
ON auth_verifications (opengeni_private.account_deletion_verification_subject_v1(identifier, value));
