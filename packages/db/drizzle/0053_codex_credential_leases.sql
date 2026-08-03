-- 0053_codex_credential_leases.sql
-- tracking-21: fair, atomic Codex subscription selection across worker replicas.
--
-- Every field in this migration is workspace-local. In particular, the same
-- external ChatGPT subscription connected in two workspaces is intentionally
-- usable concurrently: no provider identity hash, lease, cooldown, usage row, or
-- cursor crosses the workspace boundary.

-- Server-held fairness metadata. Provider usage headers remain useful capacity
-- hints, but are never the allocator's only state: live DB leases are ranked
-- first and this cursor breaks equal-load/equal-capacity ties.
ALTER TABLE "codex_subscription_credentials"
  ADD COLUMN IF NOT EXISTS "allocator_enabled" boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "selection_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_selected_at" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS "codex_subscription_credentials_workspace_id_idx"
  ON "codex_subscription_credentials" ("workspace_id", "id");

-- Never flip the legacy bit's default. Old workers only understand
-- rotation_enabled; keeping it false makes schema-first rollout and binary
-- rollback safe. New compatible code may explicitly set the separate allocator
-- bit only after every replica understands leases.
ALTER TABLE "codex_rotation_settings"
  ALTER COLUMN "rotation_enabled" SET DEFAULT false,
  ADD COLUMN IF NOT EXISTS "lease_rotation_enabled" boolean NOT NULL DEFAULT false;

-- Composite target for the lease turn FK. The id is already globally unique,
-- but including workspace_id makes tenant integrity independently enforceable.
CREATE UNIQUE INDEX IF NOT EXISTS "session_turns_workspace_id_idx"
  ON "session_turns" ("workspace_id", "id");

CREATE TABLE IF NOT EXISTS "codex_credential_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "credential_id" uuid NOT NULL,
  "turn_id" uuid NOT NULL,
  "holder_id" text NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "leased_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "codex_credential_leases_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id")
    ON DELETE CASCADE,
  CONSTRAINT "codex_credential_leases_workspace_credential_fk"
    FOREIGN KEY ("workspace_id", "credential_id")
    REFERENCES "codex_subscription_credentials"("workspace_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "codex_credential_leases_workspace_turn_fk"
    FOREIGN KEY ("workspace_id", "turn_id")
    REFERENCES "session_turns"("workspace_id", "id")
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "codex_credential_leases_workspace_turn_idx"
  ON "codex_credential_leases" ("workspace_id", "turn_id");
CREATE INDEX IF NOT EXISTS "codex_credential_leases_active_credential_idx"
  ON "codex_credential_leases" ("workspace_id", "credential_id", "leased_until");
CREATE INDEX IF NOT EXISTS "codex_credential_leases_expiry_idx"
  ON "codex_credential_leases" ("leased_until");

ALTER TABLE "codex_credential_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_credential_leases" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'codex_credential_leases'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "codex_credential_leases";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "codex_credential_leases"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- One durable capacity wait per session. This row is also the coalescing
-- commit->signal outbox: an eligibility-affecting mutation increments
-- wake_revision in the same transaction; the session workflow advances
-- observed_wake_revision only after allocator re-evaluation. A lost/duplicate
-- Temporal signal therefore cannot lose or duplicate the continuation.
CREATE UNIQUE INDEX IF NOT EXISTS "session_goals_workspace_id_idx"
  ON "session_goals" ("workspace_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_workspace_id_idx"
  ON "sessions" ("workspace_id", "id");

CREATE TABLE IF NOT EXISTS "codex_capacity_waiters" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "goal_id" uuid NOT NULL,
  "blocked_turn_id" uuid NOT NULL,
  "workflow_id" text NOT NULL,
  "generation" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'waiting',
  "goal_version" integer NOT NULL,
  "control_generation" integer NOT NULL DEFAULT 0,
  "policy_hash" text,
  "earliest_reset_at" timestamptz,
  "next_check_at" timestamptz NOT NULL,
  "reset_kind" text NOT NULL,
  "refresh_attempt" integer NOT NULL DEFAULT 0,
  "wake_revision" integer NOT NULL DEFAULT 1,
  "observed_wake_revision" integer NOT NULL DEFAULT 0,
  "last_wake_reason" text NOT NULL DEFAULT 'capacity_wait_armed',
  "resumed_turn_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "codex_capacity_waiters_status_check"
    CHECK (status IN ('waiting', 'resumed', 'superseded')),
  CONSTRAINT "codex_capacity_waiters_reset_kind_check"
    CHECK (reset_kind IN ('authoritative', 'bounded_refresh')),
  CONSTRAINT "codex_capacity_waiters_generation_check"
    CHECK (generation > 0 AND goal_version > 0 AND control_generation >= 0),
  CONSTRAINT "codex_capacity_waiters_revision_check"
    CHECK (wake_revision > 0 AND observed_wake_revision >= 0
      AND observed_wake_revision <= wake_revision),
  CONSTRAINT "codex_capacity_waiters_refresh_attempt_check"
    CHECK (refresh_attempt >= 0),
  CONSTRAINT "codex_capacity_waiters_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "codex_capacity_waiters_workspace_session_fk"
    FOREIGN KEY ("workspace_id", "session_id")
    REFERENCES "sessions"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "codex_capacity_waiters_workspace_goal_fk"
    FOREIGN KEY ("workspace_id", "goal_id")
    REFERENCES "session_goals"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "codex_capacity_waiters_workspace_blocked_turn_fk"
    FOREIGN KEY ("workspace_id", "blocked_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "codex_capacity_waiters_workspace_resumed_turn_fk"
    FOREIGN KEY ("workspace_id", "resumed_turn_id")
    REFERENCES "session_turns"("workspace_id", "id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "codex_capacity_waiters_workspace_session_idx"
  ON "codex_capacity_waiters" ("workspace_id", "session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "codex_capacity_waiters_workspace_id_idx"
  ON "codex_capacity_waiters" ("workspace_id", "id");
CREATE INDEX IF NOT EXISTS "codex_capacity_waiters_pending_idx"
  ON "codex_capacity_waiters" ("workspace_id", "status", "next_check_at");
CREATE INDEX IF NOT EXISTS "codex_capacity_waiters_wake_repair_idx"
  ON "codex_capacity_waiters" ("status", "wake_revision", "observed_wake_revision");

ALTER TABLE "codex_capacity_waiters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "codex_capacity_waiters" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'codex_capacity_waiters'
      AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "codex_capacity_waiters";
  END IF;
END $$;

CREATE POLICY workspace_isolation ON "codex_capacity_waiters"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

-- Defense in depth for legacy id-only pin/last/active FKs. Normal API/worker
-- accessors already validate workspace ownership; these triggers reject a
-- malformed internal/maintenance write too.
CREATE OR REPLACE FUNCTION opengeni_private.enforce_codex_credential_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  referenced_workspace uuid;
  candidate uuid;
BEGIN
  IF TG_TABLE_NAME = 'codex_rotation_settings' THEN
    candidate := NEW.active_credential_id;
  ELSIF TG_ARGV[0] = 'pinned' THEN
    candidate := NEW.codex_pinned_credential_id;
  ELSE
    candidate := NEW.codex_last_credential_id;
  END IF;
  IF candidate IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format(
    'SELECT workspace_id FROM %I.codex_subscription_credentials WHERE id = $1',
    TG_TABLE_SCHEMA
  ) INTO referenced_workspace USING candidate;
  IF referenced_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'Codex credential reference must remain in the row workspace'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS codex_rotation_settings_workspace_guard ON "codex_rotation_settings";
CREATE TRIGGER codex_rotation_settings_workspace_guard
BEFORE INSERT OR UPDATE OF active_credential_id, workspace_id ON "codex_rotation_settings"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace();
DROP TRIGGER IF EXISTS sessions_codex_pinned_workspace_guard ON "sessions";
CREATE TRIGGER sessions_codex_pinned_workspace_guard
BEFORE INSERT OR UPDATE OF codex_pinned_credential_id, workspace_id ON "sessions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace('pinned');
DROP TRIGGER IF EXISTS sessions_codex_last_workspace_guard ON "sessions";
CREATE TRIGGER sessions_codex_last_workspace_guard
BEFORE INSERT OR UPDATE OF codex_last_credential_id, workspace_id ON "sessions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.enforce_codex_credential_workspace('last');

DO $$
DECLARE
  target_schema text := current_schema();
  app_role text := 'opengeni_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
      target_schema,
      app_role
    );
  END IF;
END $$;
