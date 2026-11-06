-- deployment-mode: rolling
-- contract-step: Release the runtime-posture compatibility from PR #6710 before this migration; PR #6389 already removed all feature callers.
-- online-safety-exception: explicit-lock: Fence only these eleven retired tables for their closed-group drop. The predecessor release has no feature callers, and lock acquisition fails within five seconds.
-- The legacy automation intake and PR-review pack are not the current event
-- sources, scheduled tasks or automation templates. Those live tables stay.
-- No CASCADE: an unexpected surviving dependency must abort the whole file.
-- Rows left by the retired features go with their tables: no current code
-- reads them, and a DROP does not scan them however many there are.

SET LOCAL lock_timeout = '5s';

LOCK TABLE
  automation_run_event_links,
  automation_runs,
  automation_sources,
  automation_trigger_events,
  automation_trigger_revisions,
  automation_triggers,
  automation_webhook_endpoints,
  pr_review_app_registrations,
  pr_review_managed_github_authority_nonces,
  pr_review_managed_github_routes,
  pr_review_repository_bindings
IN ACCESS EXCLUSIVE MODE;

-- List the entire closed FK group in one RESTRICT drop. PostgreSQL removes
-- only its own indexes, table policies, triggers and internal constraints.
DROP TABLE
  automation_run_event_links,
  automation_runs,
  automation_sources,
  automation_trigger_events,
  automation_trigger_revisions,
  automation_triggers,
  automation_webhook_endpoints,
  pr_review_app_registrations,
  pr_review_managed_github_authority_nonces,
  pr_review_managed_github_routes,
  pr_review_repository_bindings
RESTRICT;
