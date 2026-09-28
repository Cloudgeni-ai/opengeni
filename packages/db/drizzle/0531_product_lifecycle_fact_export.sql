-- deployment-mode: rolling
-- Content-free per-person product lifecycle facts on the durable host export.
--
-- A new export kind, `lifecycle_fact`, carries one fact per sign-up, email
-- verification, sign-in, organization setup, model connection, credit
-- purchase, connection, scheduled task, installed Skill, Slack user link,
-- enrolled machine and organization join. Row triggers on the source tables
-- write the fact in the same transaction as the product change, so every
-- writer path is covered and a rolled-back change leaves no fact.
--
-- Nothing is captured until a host registers a `lifecycle_fact` consumer:
-- with the gate off each trigger reads one config row and returns. A fact is
-- a fixed type, an optional value from a fixed per-type list, a pseudonymous
-- subject (`user:` or `api_key:` identifiers only; every other subject is
-- reduced to its kind), and the organization/workspace UUIDs when the source
-- row has them. Pre-setup sign-ups and sign-ins carry no organization. No
-- name, email, address, domain, credential, amount or free text is copied.
--
-- Capture never fails the product change: a capture error rolls back only the
-- fact and raises a warning. Deterministic fact ids make every capture
-- idempotent in the outbox and at the sink.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE "host_export_config"
  ADD COLUMN IF NOT EXISTS "lifecycle_facts_enabled" boolean NOT NULL DEFAULT false;

ALTER TABLE "host_export_cursor_state"
  DROP CONSTRAINT IF EXISTS "host_export_cursor_state_kind_check",
  ADD CONSTRAINT "host_export_cursor_state_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event', 'lifecycle_fact')) NOT VALID;
ALTER TABLE "host_export_cursor_state"
  VALIDATE CONSTRAINT "host_export_cursor_state_kind_check";

-- Pre-setup sign-ups belong to no organization yet, and most facts belong to
-- no workspace, so only lifecycle rows may omit either scope.
ALTER TABLE "host_export_outbox"
  ALTER COLUMN "account_id" DROP NOT NULL,
  ALTER COLUMN "workspace_id" DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS "host_export_outbox_kind_check",
  ADD CONSTRAINT "host_export_outbox_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event', 'lifecycle_fact')) NOT VALID,
  ADD CONSTRAINT "host_export_outbox_scope_check"
    CHECK (
      ("export_kind" <> 'lifecycle_fact'
        AND "account_id" IS NOT NULL AND "workspace_id" IS NOT NULL)
      OR ("export_kind" = 'lifecycle_fact'
        AND ("workspace_id" IS NULL OR "account_id" IS NOT NULL)
        AND "session_id" IS NULL)
    ) NOT VALID;
ALTER TABLE "host_export_outbox"
  VALIDATE CONSTRAINT "host_export_outbox_kind_check";
ALTER TABLE "host_export_outbox"
  VALIDATE CONSTRAINT "host_export_outbox_scope_check";

ALTER TABLE "host_export_consumers"
  DROP CONSTRAINT IF EXISTS "host_export_consumers_kind_check",
  ADD CONSTRAINT "host_export_consumers_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event', 'lifecycle_fact')) NOT VALID;
ALTER TABLE "host_export_consumers"
  VALIDATE CONSTRAINT "host_export_consumers_kind_check";

ALTER TABLE "host_export_dead_letters"
  DROP CONSTRAINT IF EXISTS "host_export_dead_letters_kind_check",
  ADD CONSTRAINT "host_export_dead_letters_kind_check"
    CHECK ("export_kind" IN ('session_event', 'usage_event', 'lifecycle_fact')) NOT VALID;
ALTER TABLE "host_export_dead_letters"
  VALIDATE CONSTRAINT "host_export_dead_letters_kind_check";

-- The cursor state is FORCE RLS with an owner-name policy from 0097. Open the
-- owner-only window so this seed row does not depend on the migration
-- principal's name matching that policy.
ALTER TABLE "host_export_cursor_state" NO FORCE ROW LEVEL SECURITY;
INSERT INTO "host_export_cursor_state" ("export_kind")
VALUES ('lifecycle_fact')
ON CONFLICT ("export_kind") DO NOTHING;
DO $seed$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "host_export_cursor_state" WHERE "export_kind" = 'lifecycle_fact'
  ) THEN
    RAISE EXCEPTION '0531 could not seed the lifecycle_fact cursor state'
      USING ERRCODE = '55000';
  END IF;
END $seed$;
ALTER TABLE "host_export_cursor_state" FORCE ROW LEVEL SECURITY;

-- Fixed value lists. Keep in sync with PRODUCT_LIFECYCLE_FACT_ATTRIBUTES in
-- packages/contracts/src/product-lifecycle-facts.ts (a test compares them).
CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_fact_valid(
  p_fact_type text,
  p_attribute text
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT coalesce(CASE p_fact_type
    WHEN 'auth.sign_up' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'auth.email_verified' THEN p_attribute IS NULL
    WHEN 'auth.sign_in' THEN p_attribute IN ('email', 'google', 'github', 'other')
    WHEN 'organization.setup' THEN p_attribute IN ('created', 'additional')
    WHEN 'model.connected' THEN p_attribute IN (
      'codex', 'supergrok', 'vercel_gateway', 'openrouter'
    )
    WHEN 'credits.purchased' THEN p_attribute IS NULL
    WHEN 'connection.created' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'scheduled_task.created' THEN p_attribute IS NULL
    WHEN 'skill.installed' THEN p_attribute IS NULL
    WHEN 'slack.user_linked' THEN p_attribute IS NULL
    WHEN 'machine.enrolled' THEN p_attribute IS NULL
    WHEN 'member.joined' THEN p_attribute IS NULL
    ELSE false
  END, false)
$function$;

-- Better Auth provider id -> closed sign-in method.
CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_auth_method(
  p_provider_id text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE lower(btrim(coalesce(p_provider_id, '')))
    WHEN 'credential' THEN 'email'
    WHEN 'google' THEN 'google'
    WHEN 'github' THEN 'github'
    ELSE 'other'
  END
$function$;

-- Connection provider domain -> closed provider class. A domain outside this
-- list (a customer's own MCP server, for example) becomes `other` and is
-- never exported.
CREATE OR REPLACE FUNCTION opengeni_private.product_lifecycle_connection_class(
  p_provider_domain text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN host = 'slack.com' OR host LIKE '%.slack.com' THEN 'slack'
    WHEN host = 'github.com' OR host LIKE '%.github.com' THEN 'github'
    WHEN host = 'gitlab.com' OR host LIKE '%.gitlab.com' THEN 'gitlab'
    WHEN host = 'dev.azure.com' OR host LIKE '%.visualstudio.com' THEN 'azure_devops'
    WHEN host = 'bitbucket.org' OR host LIKE '%.bitbucket.org' THEN 'bitbucket'
    WHEN host IN ('google.com', 'googleapis.com')
      OR host LIKE '%.google.com' OR host LIKE '%.googleapis.com' THEN 'google'
    WHEN host IN ('microsoft.com', 'office.com', 'microsoftonline.com')
      OR host LIKE '%.microsoft.com' OR host LIKE '%.office.com'
      OR host LIKE '%.microsoftonline.com' THEN 'microsoft'
    WHEN host = 'linear.app' OR host LIKE '%.linear.app' THEN 'linear'
    WHEN host IN ('atlassian.com', 'atlassian.net')
      OR host LIKE '%.atlassian.com' OR host LIKE '%.atlassian.net' THEN 'atlassian'
    WHEN host IN ('notion.so', 'notion.com')
      OR host LIKE '%.notion.so' OR host LIKE '%.notion.com' THEN 'notion'
    WHEN host IN ('supabase.com', 'supabase.co')
      OR host LIKE '%.supabase.com' OR host LIKE '%.supabase.co' THEN 'supabase'
    WHEN host IN ('datadoghq.com', 'datadog.com', 'datadoghq.eu')
      OR host LIKE '%.datadoghq.com' OR host LIKE '%.datadog.com'
      OR host LIKE '%.datadoghq.eu' THEN 'datadog'
    WHEN host = 'posthog.com' OR host LIKE '%.posthog.com' THEN 'posthog'
    WHEN host IN ('openai.com', 'chatgpt.com')
      OR host LIKE '%.openai.com' OR host LIKE '%.chatgpt.com' THEN 'openai'
    WHEN host IN ('x.com', 'twitter.com')
      OR host LIKE '%.x.com' OR host LIKE '%.twitter.com' THEN 'x'
    ELSE 'other'
  END
  FROM (SELECT lower(btrim(coalesce(p_provider_domain, ''))) AS host) domain
$function$;

REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_fact_valid(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_auth_method(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.product_lifecycle_connection_class(text) FROM PUBLIC;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  -- The single writer of lifecycle rows. Callers are the capture trigger
  -- below only; no runtime role can execute it.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_product_lifecycle_fact(
      p_fact_type text,
      p_attribute text,
      p_subject_id text,
      p_account_id uuid,
      p_workspace_id uuid,
      p_dedupe_key text
    ) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_subject_id text;
      v_subject_kind text;
      v_source_id uuid;
      v_payload jsonb;
      v_initiator jsonb;
      v_inserted integer;
    BEGIN
      -- Share-lock the gate row exactly like session-event capture, so the
      -- consumer registration commit is the enable boundary.
      SELECT c.lifecycle_facts_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1
      FOR SHARE;
      IF coalesce(v_enabled, false) = false THEN
        RETURN false;
      END IF;

      IF NOT opengeni_private.product_lifecycle_fact_valid(p_fact_type, p_attribute) THEN
        RAISE EXCEPTION 'invalid product lifecycle fact' USING ERRCODE = '22023';
      END IF;
      IF p_dedupe_key IS NULL OR length(p_dedupe_key) NOT BETWEEN 1 AND 512 THEN
        RAISE EXCEPTION 'invalid product lifecycle fact key' USING ERRCODE = '22023';
      END IF;
      IF p_workspace_id IS NOT NULL AND p_account_id IS NULL THEN
        RAISE EXCEPTION 'product lifecycle workspace requires its organization'
          USING ERRCODE = '22023';
      END IF;

      -- Only opaque managed-user and API-key identifiers leave the database.
      -- Embedded-host, configured and other subject strings can carry host
      -- identifiers, so they are reduced to their kind.
      v_subject_id := CASE
        WHEN p_subject_id ~ '^(user|api_key):[A-Za-z0-9_-]{8,128}$' THEN p_subject_id
        ELSE NULL
      END;
      v_subject_kind := CASE
        WHEN nullif(btrim(coalesce(p_subject_id, '')), '') IS NULL THEN 'none'
        WHEN v_subject_id IS NOT NULL AND starts_with(v_subject_id, 'user:') THEN 'user'
        WHEN v_subject_id IS NOT NULL THEN 'api_key'
        WHEN starts_with(p_subject_id, 'service:') THEN 'service'
        ELSE 'other'
      END;
      v_initiator := CASE
        WHEN v_subject_id IS NULL THEN NULL
        ELSE jsonb_build_object('kind', 'subject', 'subjectId', v_subject_id)
      END;
      -- Name-based and deterministic: stamp the RFC 4122 version (5) and
      -- variant nibbles so strict UUID parsers accept the id.
      v_source_id := overlay(overlay(md5(
        'opengeni-product-lifecycle-fact:v1:' || p_fact_type || ':' || p_dedupe_key
      ) placing '5' from 13) placing '8' from 17)::uuid;
      v_payload := jsonb_build_object(
        'factType', p_fact_type,
        'attribute', p_attribute,
        'subjectKind', v_subject_kind
      );

      INSERT INTO %1$I.host_export_outbox (
        export_kind, source_id, account_id, workspace_id, event_type,
        idempotency_key, initiator, initiator_context, origin, payload,
        envelope_bytes, occurred_at, source_recorded_at, enqueued_at
      ) VALUES (
        'lifecycle_fact', v_source_id, p_account_id, p_workspace_id, p_fact_type,
        'lifecycle_fact:' || v_source_id::text, v_initiator, '{}'::jsonb, NULL,
        v_payload,
        octet_length(v_payload::text)
          + octet_length(coalesce(v_initiator, 'null'::jsonb)::text) + 512,
        clock_timestamp(), clock_timestamp(), clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      RETURN v_inserted = 1;
    END $function$;
  $create$, target_schema);

  -- One capture function for every source table. Each branch reads only the
  -- new row, except: a first identity decides a sign-up; a sign-in reads its
  -- exact login binding under the canonical identity marker (restored before
  -- returning); a membership activation checks for an earlier member of the
  -- same organization under the writer's own organization lifecycle context.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.capture_product_lifecycle_fact()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_provider text;
      v_marker text;
    BEGIN
      SELECT c.lifecycle_facts_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1;
      IF coalesce(v_enabled, false) = false THEN
        RETURN NULL;
      END IF;

      BEGIN
        CASE TG_TABLE_NAME
          WHEN 'auth_identities' THEN
            IF NOT EXISTS (
              SELECT 1 FROM %1$I.auth_identities other
              WHERE other.user_id = NEW.user_id AND other.id <> NEW.id
            ) THEN
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'auth.sign_up',
                opengeni_private.product_lifecycle_auth_method(NEW.provider_id),
                'user:' || NEW.user_id, NULL, NULL, NEW.user_id
              );
            END IF;
          WHEN 'auth_users' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'auth.email_verified', NULL, 'user:' || NEW.id, NULL, NULL, NEW.id
            );
          WHEN 'auth_sessions' THEN
            -- Session-set modes create and immediately discard an expired
            -- provider session; only a live session is a sign-in.
            IF NEW.expires_at > clock_timestamp() THEN
              v_marker := current_setting('opengeni.canonical_human_identity_lifecycle', true);
              PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
              SELECT binding.provider_id INTO v_provider
              FROM %1$I.canonical_human_login_bindings binding
              WHERE binding.id = NEW.login_binding_id;
              PERFORM set_config(
                'opengeni.canonical_human_identity_lifecycle', coalesce(v_marker, ''), true
              );
              IF v_provider IS NULL THEN
                SELECT min(identity.provider_id) INTO v_provider
                FROM %1$I.auth_identities identity
                WHERE identity.user_id = NEW.user_id
                HAVING count(*) = 1;
              END IF;
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'auth.sign_in',
                opengeni_private.product_lifecycle_auth_method(v_provider),
                'user:' || NEW.user_id, NULL, NULL, NEW.id
              );
            END IF;
          WHEN 'self_service_organization_setup_receipts' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'organization.setup', 'created', 'user:' || NEW.auth_user_id,
              NEW.account_id, NULL, NEW.account_id::text
            );
          WHEN 'additional_organization_creation_receipts' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'organization.setup', 'additional', NEW.actor_subject_id,
              NEW.account_id, NULL, NEW.account_id::text
            );
          WHEN 'codex_subscription_credentials' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'model.connected', 'codex', NEW.connected_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'xai_subscription_credentials' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'model.connected', 'supergrok', NEW.connected_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'organization_model_provider_connections' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'model.connected', NEW.provider_kind, NEW.updated_by_subject_id,
              NEW.account_id, NULL, NEW.id::text || ':' || NEW.operation_id::text
            );
          WHEN 'credit_ledger_entries' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'credits.purchased', NULL, NULL,
              NEW.account_id, NULL, NEW.id::text
            );
          WHEN 'connections' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'connection.created',
              opengeni_private.product_lifecycle_connection_class(NEW.provider_domain),
              NEW.created_by_subject_id, NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'scheduled_tasks' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'scheduled_task.created', NULL, NEW.created_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'skill_source_bindings' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'skill.installed', NULL, opengeni_private.current_subject_id(),
              NEW.account_id, NEW.workspace_id, NEW.preference_id::text
            );
          WHEN 'slack_bot_user_links' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'slack.user_linked', NULL, NEW.subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'enrollments' THEN
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'machine.enrolled', NULL, opengeni_private.current_subject_id(),
              NEW.account_id, NEW.workspace_id, NEW.id::text
            );
          WHEN 'organization_memberships' THEN
            -- The founder's own membership is covered by organization.setup.
            IF EXISTS (
              SELECT 1 FROM %1$I.organization_memberships earlier
              WHERE earlier.account_id = NEW.account_id
                AND earlier.id <> NEW.id
                AND earlier.subject_id <> NEW.subject_id
                AND earlier.created_at <= NEW.created_at
            ) THEN
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'member.joined', NULL, NEW.subject_id,
                NEW.account_id, NULL, NEW.id::text
              );
            END IF;
          ELSE
            NULL;
        END CASE;
      EXCEPTION WHEN OTHERS THEN
        -- Telemetry only: roll back the fact, never the product change.
        RAISE WARNING 'product lifecycle fact capture skipped (%%)', SQLSTATE;
      END;
      RETURN NULL;
    END $function$;
  $create$, target_schema);
END $migration$;

REVOKE ALL ON FUNCTION opengeni_private.enqueue_product_lifecycle_fact(
  text, text, text, uuid, uuid, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.capture_product_lifecycle_fact() FROM PUBLIC;

DROP TRIGGER IF EXISTS product_lifecycle_fact_sign_up ON "auth_identities";
CREATE TRIGGER product_lifecycle_fact_sign_up
AFTER INSERT ON "auth_identities"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_verified_at_signup ON "auth_users";
CREATE TRIGGER product_lifecycle_fact_verified_at_signup
AFTER INSERT ON "auth_users"
FOR EACH ROW WHEN (NEW.email_verified)
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_email_verified ON "auth_users";
CREATE TRIGGER product_lifecycle_fact_email_verified
AFTER UPDATE OF "email_verified" ON "auth_users"
FOR EACH ROW WHEN (NEW.email_verified AND NOT OLD.email_verified)
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_sign_in ON "auth_sessions";
CREATE TRIGGER product_lifecycle_fact_sign_in
AFTER INSERT ON "auth_sessions"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_organization_setup
  ON "self_service_organization_setup_receipts";
CREATE TRIGGER product_lifecycle_fact_organization_setup
AFTER INSERT ON "self_service_organization_setup_receipts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_additional_organization
  ON "additional_organization_creation_receipts";
CREATE TRIGGER product_lifecycle_fact_additional_organization
AFTER INSERT ON "additional_organization_creation_receipts"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_model_connected
  ON "codex_subscription_credentials";
CREATE TRIGGER product_lifecycle_fact_model_connected
AFTER INSERT ON "codex_subscription_credentials"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_model_connected
  ON "xai_subscription_credentials";
CREATE TRIGGER product_lifecycle_fact_model_connected
AFTER INSERT ON "xai_subscription_credentials"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- An organization provider connection is one row per provider; reconnecting
-- after a revoke reactivates it with a new operation id.
DROP TRIGGER IF EXISTS product_lifecycle_fact_model_connected
  ON "organization_model_provider_connections";
CREATE TRIGGER product_lifecycle_fact_model_connected
AFTER INSERT ON "organization_model_provider_connections"
FOR EACH ROW WHEN (NEW.status = 'active')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();
DROP TRIGGER IF EXISTS product_lifecycle_fact_model_reconnected
  ON "organization_model_provider_connections";
CREATE TRIGGER product_lifecycle_fact_model_reconnected
AFTER UPDATE OF "status" ON "organization_model_provider_connections"
FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_credits_purchased ON "credit_ledger_entries";
CREATE TRIGGER product_lifecycle_fact_credits_purchased
AFTER INSERT ON "credit_ledger_entries"
FOR EACH ROW WHEN (NEW.type = 'credit_topup')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_connection_created ON "connections";
CREATE TRIGGER product_lifecycle_fact_connection_created
AFTER INSERT ON "connections"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_scheduled_task_created ON "scheduled_tasks";
CREATE TRIGGER product_lifecycle_fact_scheduled_task_created
AFTER INSERT ON "scheduled_tasks"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_skill_installed ON "skill_source_bindings";
CREATE TRIGGER product_lifecycle_fact_skill_installed
AFTER INSERT ON "skill_source_bindings"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_slack_user_linked ON "slack_bot_user_links";
CREATE TRIGGER product_lifecycle_fact_slack_user_linked
AFTER INSERT ON "slack_bot_user_links"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_machine_enrolled ON "enrollments";
CREATE TRIGGER product_lifecycle_fact_machine_enrolled
AFTER INSERT ON "enrollments"
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_member_joined ON "organization_memberships";
CREATE TRIGGER product_lifecycle_fact_member_joined
AFTER INSERT ON "organization_memberships"
FOR EACH ROW WHEN (NEW.status = 'active')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();
DROP TRIGGER IF EXISTS product_lifecycle_fact_member_activated ON "organization_memberships";
CREATE TRIGGER product_lifecycle_fact_member_activated
AFTER UPDATE OF "status" ON "organization_memberships"
FOR EACH ROW WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- Host-export control functions learn the third kind. Bodies are unchanged
-- apart from the kind list, the gate column, and the lifecycle dead-letter
-- envelope; CREATE OR REPLACE keeps each function's owner and exporter ACL.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.register_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE v_checkpoint bigint;
    BEGIN
      IF p_export_kind NOT IN ('session_event', 'usage_event', 'lifecycle_fact') THEN
        RAISE EXCEPTION 'invalid host export kind' USING ERRCODE = '22023';
      END IF;
      IF p_consumer_id IS NULL OR length(p_consumer_id) NOT BETWEEN 1 AND 128
        OR p_consumer_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' THEN
        RAISE EXCEPTION 'invalid host export consumer id' USING ERRCODE = '22023';
      END IF;

      SELECT s.pruned_through INTO v_checkpoint
      FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      INSERT INTO %1$I.host_export_consumers (consumer_id, export_kind, checkpoint)
      VALUES (p_consumer_id, p_export_kind, v_checkpoint)
      ON CONFLICT (export_kind, consumer_id) DO UPDATE
      SET enabled = true, updated_at = now();

      UPDATE %1$I.host_export_config
      SET session_events_enabled = CASE WHEN p_export_kind = 'session_event' THEN true ELSE session_events_enabled END,
          usage_events_enabled = CASE WHEN p_export_kind = 'usage_event' THEN true ELSE usage_events_enabled END,
          lifecycle_facts_enabled = CASE WHEN p_export_kind = 'lifecycle_fact' THEN true ELSE lifecycle_facts_enabled END,
          updated_at = now()
      WHERE id = 1;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.disable_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      PERFORM 1 FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      UPDATE %1$I.host_export_consumers c
      SET enabled = false, updated_at = now()
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM %1$I.host_export_consumers c
        WHERE c.export_kind = p_export_kind AND c.enabled
      ) THEN
        UPDATE %1$I.host_export_config
        SET session_events_enabled = CASE
              WHEN p_export_kind = 'session_event' THEN false
              ELSE session_events_enabled
            END,
            usage_events_enabled = CASE
              WHEN p_export_kind = 'usage_event' THEN false
              ELSE usage_events_enabled
            END,
            lifecycle_facts_enabled = CASE
              WHEN p_export_kind = 'lifecycle_fact' THEN false
              ELSE lifecycle_facts_enabled
            END,
            updated_at = now()
        WHERE id = 1;
      END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.retire_host_export_consumer(
      p_export_kind text, p_consumer_id text
    ) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      PERFORM 1 FROM %1$I.host_export_cursor_state s
      WHERE s.export_kind = p_export_kind
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown host export kind' USING ERRCODE = '22023';
      END IF;

      DELETE FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'host export consumer not found' USING ERRCODE = 'P0002';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM %1$I.host_export_consumers c
        WHERE c.export_kind = p_export_kind AND c.enabled
      ) THEN
        UPDATE %1$I.host_export_config
        SET session_events_enabled = CASE
              WHEN p_export_kind = 'session_event' THEN false
              ELSE session_events_enabled
            END,
            usage_events_enabled = CASE
              WHEN p_export_kind = 'usage_event' THEN false
              ELSE usage_events_enabled
            END,
            lifecycle_facts_enabled = CASE
              WHEN p_export_kind = 'lifecycle_fact' THEN false
              ELSE lifecycle_facts_enabled
            END,
            updated_at = now()
        WHERE id = 1;
      END IF;
    END $function$;
  $create$, target_schema);

  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.dead_letter_host_export_head(
      p_export_kind text, p_consumer_id text, p_lease_token uuid,
      p_export_cursor bigint, p_reason text
    ) RETURNS bigint
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_consumer %1$I.host_export_consumers%%ROWTYPE;
      v_row %1$I.host_export_outbox%%ROWTYPE;
      v_envelope jsonb;
    BEGIN
      IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'dead-letter reason must contain 1 to 500 characters'
          USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_consumer
      FROM %1$I.host_export_consumers c
      WHERE c.export_kind = p_export_kind AND c.consumer_id = p_consumer_id
      FOR UPDATE;
      IF NOT FOUND OR v_consumer.lease_token IS DISTINCT FROM p_lease_token
        OR v_consumer.lease_through IS NULL THEN
        RAISE EXCEPTION 'host export lease is stale' USING ERRCODE = '40001';
      END IF;
      IF p_export_cursor IS NULL OR p_export_cursor <> v_consumer.checkpoint + 1
        OR p_export_cursor > v_consumer.lease_through THEN
        RAISE EXCEPTION 'only the leased head event may be dead-lettered'
          USING ERRCODE = '22023';
      END IF;

      SELECT * INTO STRICT v_row FROM %1$I.host_export_outbox o
      WHERE o.export_kind = p_export_kind AND o.export_cursor = p_export_cursor;
      IF p_export_kind = 'session_event' THEN
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'idempotencyKey', v_row.idempotency_key,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'event', jsonb_strip_nulls(jsonb_build_object(
            'id', v_row.source_id,
            'workspaceId', v_row.workspace_id,
            'sessionId', v_row.session_id,
            'sequence', v_row.session_sequence,
            'type', v_row.event_type,
            'payload', v_row.payload,
            'occurredAt', v_row.occurred_at,
            'clientEventId', v_row.client_event_id,
            'turnId', v_row.turn_id,
            'turnGeneration', v_row.turn_generation,
            'turnAttemptId', v_row.turn_attempt_id,
            'turnAssociation', v_row.turn_association,
            'duplicateOfEventId', v_row.duplicate_of_event_id,
            'duplicateReason', v_row.duplicate_reason
          ))
        );
      ELSIF p_export_kind = 'lifecycle_fact' THEN
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'idempotencyKey', v_row.idempotency_key,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'fact', jsonb_build_object(
            'id', v_row.source_id,
            'type', v_row.event_type,
            'attribute', v_row.payload -> 'attribute',
            'subjectKind', v_row.payload -> 'subjectKind',
            'subjectId', v_row.initiator -> 'subjectId',
            'occurredAt', v_row.occurred_at
          )
        );
      ELSE
        v_envelope := jsonb_build_object(
          'schemaRevision', '2026-07-host-export-v1',
          'cursor', v_row.export_cursor::text,
          'accountId', v_row.account_id,
          'workspaceId', v_row.workspace_id,
          'sessionId', v_row.session_id,
          'turnId', v_row.turn_id,
          'turnAttemptId', v_row.turn_attempt_id,
          'initiator', v_row.initiator,
          'initiatorContext', v_row.initiator_context,
          'origin', v_row.origin,
          'usage', v_row.payload
        );
      END IF;

      INSERT INTO %1$I.host_export_dead_letters (
        consumer_id, export_kind, export_cursor, source_id, reason, envelope,
        envelope_codec_version, event_payload_codec_version
      ) VALUES (
        p_consumer_id, p_export_kind, p_export_cursor, v_row.source_id,
        p_reason, v_envelope, NULL,
        CASE WHEN p_export_kind = 'session_event' THEN v_row.payload_codec_version ELSE NULL END
      ) ON CONFLICT (export_kind, consumer_id, export_cursor) DO NOTHING;

      UPDATE %1$I.host_export_consumers c
      SET (
        checkpoint, lease_token, lease_holder_id, lease_expires_at,
        lease_from, lease_through, consecutive_failures, next_attempt_at,
        last_error, last_error_codec_version, last_error_at, blocked_at, updated_at
      ) = (
        p_export_cursor, NULL::uuid, NULL::text, NULL::timestamptz,
        NULL::bigint, NULL::bigint, 0, now(),
        'dead-lettered: ' || p_reason, NULL::integer, now(), NULL::timestamptz, now()
      )
      WHERE c.id = v_consumer.id;
      RETURN p_export_cursor;
    END $function$;
  $create$, target_schema);
END $migration$;
