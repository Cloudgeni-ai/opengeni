-- deployment-mode: rolling
-- Candidate providers are wake hints, never eligibility or authority. NULL
-- preserves old callers; an empty array is a failover-aware empty candidate set.
ALTER TABLE subscription_capacity_waiters
  ADD COLUMN candidate_providers text[],
  ADD CONSTRAINT subscription_capacity_waiters_candidates_bounded CHECK (
    candidate_providers IS NULL OR (
      cardinality(candidate_providers) <= 32
      AND coalesce(array_ndims(candidate_providers), 1) = 1
      AND array_position(candidate_providers, NULL) IS NULL
    )
  );

CREATE INDEX subscription_capacity_waiters_candidates_idx
  ON subscription_capacity_waiters USING gin (candidate_providers);
CREATE INDEX subscription_capacity_waiters_home_scope_idx
  ON subscription_capacity_waiters (account_id, workspace_id, provider, session_id);
