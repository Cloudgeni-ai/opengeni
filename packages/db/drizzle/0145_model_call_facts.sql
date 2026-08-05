-- deployment-mode: rolling
-- Additive Workspace Insights fact table for per-model-call tokens/cache/provider
-- pivots. Written only after an authoritative agent.model.usage emit; never widens
-- the billing usage_events ledger. FORCE RLS matches usage_events isolation.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS "model_call_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "turn_attempt_id" uuid,
  "source_key" text NOT NULL,
  "provider" text NOT NULL,
  "provider_api" text NOT NULL,
  "model" text NOT NULL,
  "billing_path" text NOT NULL,
  "turn_source" text,
  "initiator_kind" text,
  "initiator_subject_id" text,
  "scheduled_task_id" uuid,
  "input_tokens" bigint,
  "output_tokens" bigint,
  "cached_tokens" bigint,
  "cache_write_tokens" bigint,
  "reasoning_tokens" bigint,
  "total_tokens" bigint,
  "priced_cost_micros" bigint NOT NULL DEFAULT 0,
  "occurred_at" timestamptz NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "model_call_facts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "model_call_facts_billing_path_check"
    CHECK ("billing_path" IN ('opengeni_credits', 'external')),
  CONSTRAINT "model_call_facts_priced_cost_check"
    CHECK ("priced_cost_micros" >= 0),
  CONSTRAINT "model_call_facts_initiator_check"
    CHECK (
      ("initiator_kind" IS NULL AND "initiator_subject_id" IS NULL)
      OR (
        "initiator_kind" IN ('subject', 'service')
        AND "initiator_subject_id" IS NOT NULL
        AND octet_length("initiator_subject_id") BETWEEN 1 AND 1024
      )
    ),
  CONSTRAINT "model_call_facts_source_key_bytes_check"
    CHECK (octet_length("source_key") BETWEEN 1 AND 1024),
  CONSTRAINT "model_call_facts_provider_bytes_check"
    CHECK (octet_length("provider") BETWEEN 1 AND 256),
  CONSTRAINT "model_call_facts_provider_api_bytes_check"
    CHECK (octet_length("provider_api") BETWEEN 1 AND 256),
  CONSTRAINT "model_call_facts_model_bytes_check"
    CHECK (octet_length("model") BETWEEN 1 AND 512)
);

CREATE UNIQUE INDEX IF NOT EXISTS "model_call_facts_workspace_turn_source_uq"
  ON "model_call_facts" ("workspace_id", "turn_id", "source_key");

CREATE INDEX IF NOT EXISTS "model_call_facts_workspace_occurred_idx"
  ON "model_call_facts" ("workspace_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "model_call_facts_workspace_provider_model_occurred_idx"
  ON "model_call_facts" ("workspace_id", "provider", "model", "occurred_at");

CREATE INDEX IF NOT EXISTS "model_call_facts_workspace_session_occurred_idx"
  ON "model_call_facts" ("workspace_id", "session_id", "occurred_at");

CREATE INDEX IF NOT EXISTS "model_call_facts_workspace_scheduled_task_occurred_idx"
  ON "model_call_facts" ("workspace_id", "scheduled_task_id", "occurred_at")
  WHERE "scheduled_task_id" IS NOT NULL;

ALTER TABLE "model_call_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "model_call_facts" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "model_call_facts_account_workspace_isolation" ON "model_call_facts";
CREATE POLICY "model_call_facts_account_workspace_isolation" ON "model_call_facts"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.model_call_facts TO opengeni_app',
      target_schema
    );
  END IF;
END $grants$;

RESET statement_timeout;
RESET lock_timeout;
