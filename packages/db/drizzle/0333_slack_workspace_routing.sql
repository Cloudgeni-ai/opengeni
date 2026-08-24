-- deployment-mode: rolling
-- Per-channel and per-DM Slack workspace routing. The installation binding is
-- untouched: one team still resolves to one credential and one home workspace.
--
-- Two tenancy scopes, not one relocated workspace. HOME is the installation
-- binding's (account_id, workspace_id): it owns the `connections` row and bot
-- credential, the bot post/update/delete ledgers, `slack_interaction_inbox`,
-- `slack_bot_user_links`, `slack_app_home_refreshes`, reaction-summon settings,
-- Slack task policy, and every table created here. TARGET is the routed
-- (account_id, workspace_id): it owns the `slack_interactions` row, its action
-- handles, its progress deliveries, the grant, the session, and the session
-- events. Posting from a routed workspace on the installation's connection
-- fails hard, so the bot client is always built from HOME.
--
-- Cross-organization targeting is out of scope: `target_account_id =
-- account_id` is a table CHECK. Dropping that CHECK later is a rolling
-- migration; adding it later is not.
--
-- Rolling: every element is additive and there is no backfill. `route_state IS
-- NULL` on the inbox means "legacy / never routed" and is exactly today's
-- behaviour, so an old API image ignores these tables and columns and keeps
-- single-workspace behaviour.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

-- One channel routes to one workspace within the installation's organization.
-- The row is the durable ask-once memory: once a human picks, or an admin sets
-- it in the web sheet, later messages in that channel never ask again.
CREATE TABLE "slack_channel_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "target_account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "target_workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "decided_by_subject_id" text NOT NULL,
  "decided_by_slack_user_id" text NOT NULL,
  "source" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_channel_routes_channel_uq"
    UNIQUE ("connection_id", "slack_channel_id"),
  CONSTRAINT "slack_channel_routes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_channel_routes_target_workspace_account_fk"
    FOREIGN KEY ("target_workspace_id", "target_account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_channel_routes_same_account_check"
    CHECK ("target_account_id" = "account_id"),
  CONSTRAINT "slack_channel_routes_bounds_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_channel_id") BETWEEN 1 AND 64
      AND octet_length("decided_by_subject_id") BETWEEN 1 AND 1024
      AND octet_length("decided_by_slack_user_id") BETWEEN 1 AND 64
      AND "source" IN ('picker', 'admin')
      AND "version" > 0
    )
);

CREATE INDEX "slack_channel_routes_target_idx"
  ON "slack_channel_routes" ("target_workspace_id", "slack_team_id");

-- One Slack human's direct messages route to one workspace. Absent a row, a DM
-- derives that human's own personal workspace from their active organization
-- membership pointer; the id is never accepted from a Slack payload.
CREATE TABLE "slack_user_dm_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "target_account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "target_workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "decided_by_subject_id" text NOT NULL,
  "decided_by_slack_user_id" text NOT NULL,
  "source" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_user_dm_routes_user_uq"
    UNIQUE ("connection_id", "slack_user_id"),
  CONSTRAINT "slack_user_dm_routes_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_user_dm_routes_target_workspace_account_fk"
    FOREIGN KEY ("target_workspace_id", "target_account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_user_dm_routes_same_account_check"
    CHECK ("target_account_id" = "account_id"),
  CONSTRAINT "slack_user_dm_routes_bounds_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_user_id") BETWEEN 1 AND 64
      AND octet_length("decided_by_subject_id") BETWEEN 1 AND 1024
      AND octet_length("decided_by_slack_user_id") BETWEEN 1 AND 64
      AND "source" IN ('picker', 'admin')
      AND "version" > 0
    )
);

CREATE INDEX "slack_user_dm_routes_target_idx"
  ON "slack_user_dm_routes" ("target_workspace_id", "slack_team_id");

-- The pending first-use picker. `slack_interaction_action_handles` cannot carry
-- it: that table's `session_id` is NOT NULL and composite-FK'd to an existing
-- `slack_interactions` row, while a picker exists BEFORE any session.
--
-- `inbox_id` deliberately carries no foreign key. The `awaiting_choice` inbox
-- row is settled `processed` before the human answers, so the answer arrives as
-- its own `block_action` inbox row; this column is provenance, not a live edge.
--
-- `request_text` mirrors `slack_interaction_inbox_bounds_check`'s exact 12000
-- byte bound so a prompt can always carry the originating row's text
-- losslessly, and `provider_event_id` is the ORIGINAL event so the answer can
-- re-materialize it under the inbox's own dedupe unique.
CREATE TABLE "slack_route_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "inbox_id" uuid NOT NULL,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "slack_message_ts" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "trigger_kind" text NOT NULL,
  "request_text" text NOT NULL,
  "has_files" boolean NOT NULL DEFAULT false,
  "slack_thread_ts" text,
  "message_operation_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "answered_target_account_id" uuid,
  "answered_target_workspace_id" uuid,
  "answered_by_subject_id" text,
  "answered_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_route_prompts_inbox_uq" UNIQUE ("connection_id", "inbox_id"),
  CONSTRAINT "slack_route_prompts_event_uq" UNIQUE ("connection_id", "provider_event_id"),
  CONSTRAINT "slack_route_prompts_identity_uq" UNIQUE ("account_id", "workspace_id", "id"),
  CONSTRAINT "slack_route_prompts_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_route_prompts_status_check"
    CHECK ("status" IN ('pending', 'answered', 'expired', 'cancelled')),
  CONSTRAINT "slack_route_prompts_trigger_check"
    CHECK (
      "trigger_kind" IN (
        'app_mention', 'dm', 'reaction', 'slash_command',
        'message_shortcut', 'thread_reply', 'block_action'
      )
    ),
  CONSTRAINT "slack_route_prompts_answer_check"
    CHECK (
      ("status" = 'answered') = ("answered_target_workspace_id" IS NOT NULL)
      AND ("answered_target_account_id" IS NULL) = ("answered_target_workspace_id" IS NULL)
      AND ("answered_target_account_id" IS NULL OR "answered_target_account_id" = "account_id")
      AND ("answered_target_workspace_id" IS NULL) = ("answered_at" IS NULL)
    ),
  CONSTRAINT "slack_route_prompts_bounds_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_user_id") BETWEEN 1 AND 64
      AND octet_length("slack_channel_id") BETWEEN 1 AND 64
      AND octet_length("slack_message_ts") BETWEEN 1 AND 64
      AND octet_length("provider_event_id") BETWEEN 1 AND 256
      AND octet_length("request_text") BETWEEN 1 AND 12000
      AND ("slack_thread_ts" IS NULL OR octet_length("slack_thread_ts") BETWEEN 1 AND 64)
      AND (
        "answered_by_subject_id" IS NULL
        OR octet_length("answered_by_subject_id") BETWEEN 1 AND 1024
      )
    )
);

CREATE INDEX "slack_route_prompts_pending_idx"
  ON "slack_route_prompts" ("expires_at", "id")
  WHERE "status" = 'pending';

-- One row per offered workspace. The row `id` is the Slack button `value`, so
-- it must be a UUID: the block-action normalizer already requires that shape,
-- which is why the picker uses buttons rather than a `static_select`.
--
-- These rows are a snapshot taken at prompt time and are NEVER authority. The
-- answer path re-authorizes the chosen workspace live.
CREATE TABLE "slack_route_prompt_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "prompt_id" uuid NOT NULL,
  "candidate_account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "candidate_workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "candidate_label" text NOT NULL,
  "position" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_route_prompt_options_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_route_prompt_options_prompt_fk"
    FOREIGN KEY ("account_id", "workspace_id", "prompt_id")
    REFERENCES "slack_route_prompts"("account_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "slack_route_prompt_options_candidate_workspace_account_fk"
    FOREIGN KEY ("candidate_workspace_id", "candidate_account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "slack_route_prompt_options_prompt_workspace_uq"
    UNIQUE ("prompt_id", "candidate_workspace_id"),
  CONSTRAINT "slack_route_prompt_options_prompt_position_uq"
    UNIQUE ("prompt_id", "position"),
  CONSTRAINT "slack_route_prompt_options_same_account_check"
    CHECK ("candidate_account_id" = "account_id"),
  CONSTRAINT "slack_route_prompt_options_bounds_check"
    CHECK (
      octet_length("candidate_label") BETWEEN 1 AND 128
      AND "position" >= 0
    )
);

ALTER TABLE "slack_channel_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_channel_routes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_dm_routes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_user_dm_routes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_route_prompts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_route_prompts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_route_prompt_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_route_prompt_options" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "slack_channel_routes"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "slack_user_dm_routes"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "slack_route_prompts"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "slack_route_prompt_options"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- The inbox keeps HOME tenancy. `account_id`/`workspace_id` stay NOT NULL on
-- purpose: `opengeni_private.workspace_rls_visible` is strict equality, so a
-- NULL `workspace_id` would make an un-routed row invisible to EVERY tenant
-- including its own, and `settleSlackInteractionInbox` would update zero rows
-- while reporting success.
--
-- `target_workspace_id` deliberately carries no foreign key. An inbox row is
-- short-lived and definer-claimed; a runtime re-check degrades to "ask again",
-- while an FK would hard-fail on a workspace deleted mid-flight.
ALTER TABLE "slack_interaction_inbox"
  ADD COLUMN "route_state" text,
  ADD COLUMN "target_account_id" uuid,
  ADD COLUMN "target_workspace_id" uuid,
  ADD COLUMN "route_prompt_id" uuid,
  ADD COLUMN "route_prompt_expires_at" timestamptz;

ALTER TABLE "slack_interaction_inbox"
  ADD CONSTRAINT "slack_interaction_inbox_route_check"
  CHECK (
    "route_state" IS NULL
    OR (
      "route_state" IN ('resolved', 'awaiting_choice', 'denied')
      AND ("route_state" = 'resolved') = ("target_workspace_id" IS NOT NULL)
      AND ("target_account_id" IS NULL) = ("target_workspace_id" IS NULL)
      AND ("target_account_id" IS NULL OR "target_account_id" = "account_id")
      AND ("route_state" = 'awaiting_choice') = ("route_prompt_id" IS NOT NULL)
    )
  ) NOT VALID;

ALTER TABLE "slack_interaction_inbox"
  VALIDATE CONSTRAINT "slack_interaction_inbox_route_check";

-- Frozen at bind time, never looked up at post time: a workspace rename between
-- the original post and a reconciliation would otherwise make the byte-compare
-- in `reconcilePostMessage` raise `post_reconciliation_mismatch`.
ALTER TABLE "slack_interactions"
  ADD COLUMN "routed_workspace_label" text;

ALTER TABLE "slack_interactions"
  ADD CONSTRAINT "slack_interactions_routed_label_check"
  CHECK (
    "routed_workspace_label" IS NULL
    OR octet_length("routed_workspace_label") BETWEEN 1 AND 128
  ) NOT VALID;

ALTER TABLE "slack_interactions"
  VALIDATE CONSTRAINT "slack_interactions_routed_label_check";

-- The ONE new SECURITY DEFINER routine: a narrow, content-free tenancy probe.
--
-- Thread continuation must cross workspaces because `slack_interactions_route_uq`
-- is `(connection_id, route_key)` and therefore connection-global, while every
-- ordinary interaction read is workspace-fenced. This returns ids only - no
-- text, no subject, no session content - and it cannot widen visibility,
-- because the caller must then re-read the full row under the returned
-- tenancy's own RLS.
--
-- SECURITY DEFINER alone is NOT enough here. `slack_interactions` carries
-- `FORCE ROW LEVEL SECURITY`, which binds the TABLE OWNER, and OpenGeni's
-- migration principal is a non-superuser without `BYPASSRLS`. The routine
-- therefore executes as a role the strict `workspace_isolation` policy still
-- applies to, and a bare definer probe returns ZERO rows for exactly the
-- cross-workspace lookup it exists for. This uses the same private
-- transaction-capability seam migration 0243 established for Google Drive
-- object ACLs: one transaction-local row in a private table opens one
-- owner-checked permissive SELECT policy for the duration of the probe.
-- `opengeni_app` holds no privilege on the capability table and cannot forge
-- the path through a custom GUC.
--
-- `resolve_slack_installation`, `slack_installation_bindings_active_team_uq`,
-- and `sync_slack_installation_binding()` are deliberately NOT touched: one team
-- still installs into exactly one home workspace and one credential. Routing is
-- a separate, additive fact.
CREATE TABLE opengeni_private.slack_routing_runtime_capabilities (
  "backend_pid" integer NOT NULL,
  "transaction_id" xid8 NOT NULL,
  "capability_kind" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "slack_routing_runtime_capabilities_kind_chk" CHECK (
    "capability_kind" IN ('interaction_tenancy')
  ),
  CONSTRAINT "slack_routing_runtime_capabilities_pk" PRIMARY KEY (
    "backend_pid", "transaction_id", "capability_kind"
  )
);
REVOKE ALL ON TABLE opengeni_private.slack_routing_runtime_capabilities FROM PUBLIC;

CREATE FUNCTION opengeni_private.slack_routing_capability_active()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = opengeni_private, pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM slack_routing_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = 'interaction_tenancy'
  );
$$;
REVOKE ALL ON FUNCTION opengeni_private.slack_routing_capability_active() FROM PUBLIC;

-- Permissive SELECT, additive to the existing `workspace_isolation` policy and
-- gated on BOTH the effective role being the table owner AND a live capability
-- row. The pre-existing RESTRICTIVE `session_visibility_isolation` policy on
-- this table still applies, so this never widens session visibility.
DO $slack_routing_capability_policy$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($policy$
    CREATE POLICY slack_routing_capability_read ON %1$I.slack_interactions
    FOR SELECT USING (
      current_user = pg_catalog.pg_get_userbyid(
        (SELECT relation.relowner
         FROM pg_catalog.pg_class relation
         WHERE relation.oid = %2$L::pg_catalog.regclass)
      )
      AND opengeni_private.slack_routing_capability_active()
    )
  $policy$, data_schema, data_schema || '.slack_interactions');
END
$slack_routing_capability_policy$;

DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.resolve_slack_interaction_tenancy(
      p_connection_id uuid,
      p_route_key text
    )
    RETURNS TABLE (account_id uuid, workspace_id uuid, interaction_id uuid)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = %1$I, pg_catalog
    AS $body$
    BEGIN
      IF p_connection_id IS NULL OR p_route_key IS NULL THEN
        RETURN;
      END IF;
      INSERT INTO opengeni_private.slack_routing_runtime_capabilities (
        backend_pid, transaction_id, capability_kind
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'interaction_tenancy'
      ) ON CONFLICT DO NOTHING;
      BEGIN
        RETURN QUERY
          SELECT I.account_id, I.workspace_id, I.id
          FROM slack_interactions I
          WHERE I.connection_id = p_connection_id
            AND I.route_key = p_route_key
          LIMIT 1;
        DELETE FROM opengeni_private.slack_routing_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'interaction_tenancy';
        RETURN;
      EXCEPTION WHEN OTHERS THEN
        DELETE FROM opengeni_private.slack_routing_runtime_capabilities
        WHERE backend_pid = pg_catalog.pg_backend_pid()
          AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability_kind = 'interaction_tenancy';
        RAISE;
      END;
    END;
    $body$
  $ddl$, data_schema);
END
$privileged_functions$;

REVOKE ALL ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(uuid, text)
  FROM PUBLIC;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_channel_routes TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_user_dm_routes TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_route_prompts TO opengeni_app',
      target_schema
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_route_prompt_options TO opengeni_app',
      target_schema
    );
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_slack_interaction_tenancy(uuid, text)
      TO opengeni_app;
    REVOKE ALL ON TABLE opengeni_private.slack_routing_runtime_capabilities FROM opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.slack_routing_capability_active()
      TO opengeni_app;
  END IF;
END
$grants$;

COMMENT ON TABLE "slack_channel_routes" IS
  'Per-channel Slack workspace routing within one organization; home tenancy owns the row, target tenancy owns the session.';
COMMENT ON TABLE "slack_user_dm_routes" IS
  'Per-Slack-human direct-message workspace routing; absent a row a DM derives that human own personal workspace.';
COMMENT ON TABLE "slack_route_prompts" IS
  'Pending first-use Slack workspace picker plus its bounded original request; the answer arrives as its own block_action event.';
COMMENT ON TABLE "slack_route_prompt_options" IS
  'Offered picker workspaces; the row id is the Slack button value and is a prompt-time snapshot, never authority.';

RESET statement_timeout;
RESET lock_timeout;
