-- deployment-mode: rolling
-- Durable Slack-to-OpenGeni ingress, identity mapping, thread/session routing,
-- and delivery cursors. Signed HTTP ingress stores only bounded normalized
-- fields; raw bodies, headers, signing secrets, bot tokens, and response URLs
-- never enter these tables.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE "slack_bot_user_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "linked_by_subject_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_bot_user_links_connection_user_uq"
    UNIQUE ("connection_id", "slack_user_id"),
  CONSTRAINT "slack_bot_user_links_identity_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_user_id") BETWEEN 1 AND 64
      AND octet_length("subject_id") BETWEEN 1 AND 1024
      AND octet_length("linked_by_subject_id") BETWEEN 1 AND 1024
    )
);

CREATE INDEX "slack_bot_user_links_workspace_subject_idx"
  ON "slack_bot_user_links" ("workspace_id", "subject_id");

CREATE TABLE "slack_interaction_inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "provider_event_id" text NOT NULL,
  "provider_message_id" text NOT NULL,
  "slack_team_id" text NOT NULL,
  "slack_user_id" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "slack_message_ts" text NOT NULL,
  "slack_thread_ts" text,
  "trigger_kind" text NOT NULL,
  "text" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "claim_holder_id" uuid,
  "claim_expires_at" timestamptz,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  "processed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_interaction_inbox_provider_event_uq"
    UNIQUE ("connection_id", "provider_event_id"),
  CONSTRAINT "slack_interaction_inbox_provider_message_uq"
    UNIQUE ("connection_id", "provider_message_id"),
  CONSTRAINT "slack_interaction_inbox_bounds_check"
    CHECK (
      octet_length("provider_event_id") BETWEEN 1 AND 256
      AND octet_length("provider_message_id") BETWEEN 1 AND 256
      AND octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_user_id") BETWEEN 1 AND 64
      AND octet_length("slack_channel_id") BETWEEN 1 AND 64
      AND octet_length("slack_message_ts") BETWEEN 1 AND 64
      AND ("slack_thread_ts" IS NULL OR octet_length("slack_thread_ts") BETWEEN 1 AND 64)
      AND octet_length("text") BETWEEN 1 AND 12000
      AND ("last_error_code" IS NULL OR octet_length("last_error_code") BETWEEN 1 AND 128)
    ),
  CONSTRAINT "slack_interaction_inbox_trigger_check"
    CHECK ("trigger_kind" IN ('app_mention', 'dm', 'slash_command', 'message_shortcut', 'thread_reply')),
  CONSTRAINT "slack_interaction_inbox_status_check"
    CHECK ("status" IN ('pending', 'processing', 'processed', 'failed')),
  CONSTRAINT "slack_interaction_inbox_claim_check"
    CHECK (("claim_holder_id" IS NULL) = ("claim_expires_at" IS NULL)),
  CONSTRAINT "slack_interaction_inbox_completion_check"
    CHECK (("status" IN ('processed', 'failed')) = ("processed_at" IS NOT NULL))
);

CREATE INDEX "slack_interaction_inbox_pending_idx"
  ON "slack_interaction_inbox" ("status", "created_at", "id")
  WHERE "status" IN ('pending', 'processing');

CREATE TABLE "slack_interactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "connections"("id") ON DELETE CASCADE,
  "slack_team_id" text NOT NULL,
  "slack_channel_id" text NOT NULL,
  "slack_thread_ts" text NOT NULL,
  "route_key" text NOT NULL,
  "triggering_provider_event_id" text NOT NULL,
  "owning_subject_id" text NOT NULL,
  "visibility" text NOT NULL,
  "session_id" uuid REFERENCES "sessions"("id") ON DELETE CASCADE,
  "last_delivered_session_event_sequence" integer NOT NULL DEFAULT 0,
  "delivery_claim_holder_id" uuid,
  "delivery_claim_expires_at" timestamptz,
  "ack_slack_message_ts" text,
  "progress_count" integer NOT NULL DEFAULT 0,
  "terminal_delivery_state" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "slack_interactions_route_uq" UNIQUE ("connection_id", "route_key"),
  CONSTRAINT "slack_interactions_bounds_check"
    CHECK (
      octet_length("slack_team_id") BETWEEN 1 AND 64
      AND octet_length("slack_channel_id") BETWEEN 1 AND 64
      AND octet_length("slack_thread_ts") BETWEEN 1 AND 64
      AND octet_length("route_key") BETWEEN 1 AND 256
      AND octet_length("triggering_provider_event_id") BETWEEN 1 AND 256
      AND octet_length("owning_subject_id") BETWEEN 1 AND 1024
      AND ("ack_slack_message_ts" IS NULL OR octet_length("ack_slack_message_ts") BETWEEN 1 AND 64)
      AND "last_delivered_session_event_sequence" >= 0
      AND "progress_count" >= 0
    ),
  CONSTRAINT "slack_interactions_delivery_claim_check"
    CHECK (("delivery_claim_holder_id" IS NULL) = ("delivery_claim_expires_at" IS NULL)),
  CONSTRAINT "slack_interactions_visibility_check"
    CHECK ("visibility" IN ('private', 'workspace')),
  CONSTRAINT "slack_interactions_terminal_check"
    CHECK ("terminal_delivery_state" IN ('open', 'completed', 'failed', 'cancelled', 'blocked'))
);

CREATE UNIQUE INDEX "slack_interactions_workspace_session_uq"
  ON "slack_interactions" ("workspace_id", "session_id")
  WHERE "session_id" IS NOT NULL;
CREATE INDEX "slack_interactions_delivery_idx"
  ON "slack_interactions" ("terminal_delivery_state", "updated_at", "id")
  WHERE "session_id" IS NOT NULL AND "terminal_delivery_state" = 'open';

ALTER TABLE "slack_bot_user_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_bot_user_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_interaction_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_interaction_inbox" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_interactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_interactions" FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON "slack_bot_user_links"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "slack_interaction_inbox"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY workspace_isolation ON "slack_interactions"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));

-- Resolve and claim through SECURITY DEFINER without trusting the caller's
-- search_path (including pg_temp). The migration may target public or a
-- dedicated embed schema, so bind current_schema() into every relation and
-- return type at creation time, then expose only pg_catalog at execution time.
DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.resolve_slack_installation(p_team_id text)
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      connection_id uuid,
      bot_id text,
      bot_user_id text
    )
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
      WITH eligible AS (
        SELECT
          C.account_id,
          C.workspace_id,
          C.id AS connection_id,
          C.metadata->>'botId' AS bot_id,
          C.metadata->>'botUserId' AS bot_user_id,
          C.created_at
        FROM %1$I.connections C
        WHERE C.provider_domain = 'slack.com'
          AND C.kind = 'app_install'
          AND C.subject_id IS NULL
          AND C.status = 'active'
          AND C.verified_install_at IS NOT NULL
          AND C.verified_install_version = C.version
          AND C.metadata->>'credentialRole' = 'opengeni_slack_bot'
          AND C.metadata->>'slackTeamId' = p_team_id
          AND octet_length(C.metadata->>'botId') BETWEEN 1 AND 64
          AND octet_length(C.metadata->>'botUserId') BETWEEN 1 AND 64
      ), unambiguous AS (
        SELECT count(DISTINCT (workspace_id, bot_id, bot_user_id)) AS principal_count
        FROM eligible
      )
      SELECT E.account_id, E.workspace_id, E.connection_id, E.bot_id, E.bot_user_id
      FROM eligible E, unambiguous U
      WHERE U.principal_count = 1
      ORDER BY E.created_at DESC, E.connection_id DESC
      LIMIT 1
    $function$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_inbox(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.slack_interaction_inbox
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack inbox claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT I.id
        FROM %1$I.slack_interaction_inbox I
        WHERE I.status = 'pending'
           OR (I.status = 'processing' AND I.claim_expires_at <= now())
        ORDER BY I.created_at, I.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_interaction_inbox I
      SET status = 'processing',
          claim_holder_id = p_holder,
          claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          attempt_count = I.attempt_count + 1,
          updated_at = now()
      FROM candidate C
      WHERE I.id = C.id
      RETURNING I.*;
    END
    $function$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_slack_interaction_delivery(
      p_holder uuid,
      p_lease_ms integer
    )
    RETURNS SETOF %1$I.slack_interactions
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
        RAISE EXCEPTION 'invalid Slack delivery claim lease';
      END IF;
      RETURN QUERY
      WITH candidate AS (
        SELECT I.id
        FROM %1$I.slack_interactions I
        WHERE I.session_id IS NOT NULL
          AND I.terminal_delivery_state = 'open'
          AND (I.delivery_claim_holder_id IS NULL OR I.delivery_claim_expires_at <= now())
          AND EXISTS (
            SELECT 1
            FROM %1$I.session_events E
            WHERE E.workspace_id = I.workspace_id
              AND E.session_id = I.session_id
              AND E.sequence > I.last_delivered_session_event_sequence
              AND E.type IN (
                'agent.message.completed',
                'session.humanInput.requested',
                'turn.completed',
                'turn.failed',
                'turn.cancelled',
                'session.status.changed'
              )
          )
        ORDER BY I.updated_at, I.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE %1$I.slack_interactions I
      SET delivery_claim_holder_id = p_holder,
          delivery_claim_expires_at = now() + make_interval(secs => p_lease_ms::double precision / 1000),
          updated_at = now()
      FROM candidate C
      WHERE I.id = C.id
      RETURNING I.*;
    END
    $function$
  $ddl$, data_schema);
END
$privileged_functions$;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_bot_user_links TO opengeni_app', target_schema);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_interaction_inbox TO opengeni_app', target_schema);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.slack_interactions TO opengeni_app', target_schema);
    GRANT EXECUTE ON FUNCTION opengeni_private.resolve_slack_installation(text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_slack_interaction_inbox(uuid, integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.claim_slack_interaction_delivery(uuid, integer) TO opengeni_app;
  END IF;
END
$grants$;

RESET statement_timeout;
RESET lock_timeout;