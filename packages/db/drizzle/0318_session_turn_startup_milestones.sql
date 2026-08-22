-- deployment-mode: rolling
-- Per-turn startup-milestone ledger.
--
-- The turn-startup SLO receipts (queue, provider_dispatch, first_byte) used to
-- be decided by re-reading the turn's `session_events` rows on every inserted
-- `turn.started`, `agent.model.request started|first_byte|first_event`, and
-- `turn.failed` event: "is the event this transaction just inserted the
-- lowest-sequence canonical checkpoint of its kind in the turn?". That lookup
-- is O(events in the turn) per model request, each examined row pays the
-- session-events RLS predicate, and it runs inside the event-append
-- transaction that holds the workspace inference-control row FOR SHARE. On a
-- long orchestrator turn it held that row for tens of seconds per model
-- request and starved every FOR UPDATE taker (Send/Steer/Pause).
--
-- This table makes "the first inserter of each checkpoint wins" a single
-- primary-key probe: the transaction that appends a checkpoint event performs
-- `INSERT ... ON CONFLICT DO NOTHING RETURNING`, and only a returned row is a
-- metric receipt. Ordinary attempt recovery and callback replay conflict and
-- stay no-ops, exactly as before. Writers already hold the turn row FOR UPDATE
-- (the canonical event-write lock order), so the conflict clause is
-- idempotency, not a race resolver.
--
-- Rollout: turns whose `turn.started` was already durable before a
-- ledger-aware writer touched them (in flight across the deploy, or claimed by
-- a pre-ledger worker during the rolling window) are recognised at their next
-- `turn.started` claim through one bounded index probe for an earlier current
-- `turn.started` row, and sealed with `pre_ledger_history` sentinel rows for
-- every completed checkpoint. Such a turn emits no further startup receipts
-- (it already observed them, or may have) instead of re-observing a checkpoint
-- with a duration equal to its age. No migration-time backfill over
-- FORCE-RLS tables is required.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "session_turn_startup_milestones" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "milestone" text NOT NULL,
  "outcome" text NOT NULL,
  "canonical_source" text NOT NULL,
  "event_id" uuid,
  "occurred_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "session_turn_startup_milestones_pkey"
    PRIMARY KEY ("workspace_id", "turn_id", "milestone", "outcome"),
  CONSTRAINT "session_turn_startup_milestones_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_startup_milestones_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_startup_milestones_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "session_turn_startup_milestones_milestone_chk"
    CHECK ("milestone" IN ('queue', 'provider_dispatch', 'first_byte')),
  CONSTRAINT "session_turn_startup_milestones_outcome_chk"
    CHECK ("outcome" IN ('completed', 'failed')),
  CONSTRAINT "session_turn_startup_milestones_checkpoint_chk"
    CHECK ("outcome" = 'completed' OR "milestone" = 'first_byte'),
  CONSTRAINT "session_turn_startup_milestones_canonical_source_chk" CHECK (
    (
      "canonical_source" = 'inserted_event'
      AND "event_id" IS NOT NULL
      AND "occurred_at" IS NOT NULL
    )
    OR (
      "canonical_source" = 'pre_ledger_history'
      AND "outcome" = 'completed'
      AND "event_id" IS NULL
      AND "occurred_at" IS NULL
    )
  )
);

-- The session FK cascade must not sequentially scan the ledger per deleted
-- session; the turn and workspace FKs are covered by the primary-key prefix.
CREATE INDEX "session_turn_startup_milestones_workspace_session_idx"
  ON "session_turn_startup_milestones" ("workspace_id", "session_id");

ALTER TABLE "session_turn_startup_milestones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_turn_startup_milestones" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_turn_startup_milestones"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation ON "session_turn_startup_milestones"
  AS RESTRICTIVE
  USING (session_reference_visible(
    "account_id", "workspace_id", "session_id"
  ))
  WITH CHECK (session_reference_visible(
    "account_id", "workspace_id", "session_id"
  ));

-- The runtime role claims (INSERT), fences (SELECT), and seals pre-ledger turns
-- (UPDATE of the turn's own queue row); rows leave only through the turn
-- cascade. `db:provision-roles` re-converges the same posture.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE ON "session_turn_startup_milestones" TO opengeni_app;
    REVOKE DELETE ON "session_turn_startup_milestones" FROM opengeni_app;
  END IF;
END
$grants$;

COMMENT ON TABLE "session_turn_startup_milestones" IS
  'Per-turn startup SLO checkpoint ledger: one row per (turn, milestone, outcome). The transaction whose INSERT ... ON CONFLICT DO NOTHING returns the row is the canonical inserter and the sole metric receipt; recovery and replay conflict. pre_ledger_history rows seal a turn whose startup predates the ledger so it never re-observes a checkpoint.';
COMMENT ON COLUMN "session_turn_startup_milestones"."canonical_source" IS
  'inserted_event: event_id/occurred_at name the canonical checkpoint event inserted by the claiming transaction. pre_ledger_history: the checkpoint was (or may have been) durable before any ledger-aware writer touched the turn; identity is deliberately not recovered from session_events.';
COMMENT ON COLUMN "session_turn_startup_milestones"."occurred_at" IS
  'The canonical event''s own occurred_at; the receipt duration is measured from session_turns.created_at to this instant.';
