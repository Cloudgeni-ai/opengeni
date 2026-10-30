-- deployment-mode: rolling
-- contract-step: Release the runtime-posture compatibility from PR #6710 before this migration; PR #6389 already removed all feature callers.
-- The legacy automation intake and PR-review pack are not the current event
-- sources, scheduled tasks or automation templates. Those live tables stay.
-- No CASCADE: an unexpected surviving dependency must abort the whole file.
-- No data loss by assumption: every retired table must actually be empty.

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

-- The migration owner is NOSUPERUSER NOBYPASSRLS. Only it, not the runtime
-- role, gains visibility in this transaction; failure rolls the window back.
ALTER TABLE automation_run_event_links NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_trigger_revisions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE automation_triggers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_review_app_registrations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_review_managed_github_authority_nonces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pr_review_repository_bindings NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM automation_run_event_links)
    OR EXISTS (SELECT 1 FROM automation_runs)
    OR EXISTS (SELECT 1 FROM automation_sources)
    OR EXISTS (SELECT 1 FROM automation_trigger_events)
    OR EXISTS (SELECT 1 FROM automation_trigger_revisions)
    OR EXISTS (SELECT 1 FROM automation_triggers)
    OR EXISTS (SELECT 1 FROM automation_webhook_endpoints)
    OR EXISTS (SELECT 1 FROM pr_review_app_registrations)
    OR EXISTS (SELECT 1 FROM pr_review_managed_github_authority_nonces)
    OR EXISTS (SELECT 1 FROM pr_review_managed_github_routes)
    OR EXISTS (SELECT 1 FROM pr_review_repository_bindings)
  THEN
    RAISE EXCEPTION 'retired automation or PR-review tables still contain rows; reconcile them before contraction'
      USING ERRCODE = '55000';
  END IF;
END
$$;

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
