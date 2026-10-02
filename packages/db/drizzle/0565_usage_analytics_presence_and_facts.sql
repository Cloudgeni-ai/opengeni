-- deployment-mode: rolling
-- Server-side usage analytics: human presence, credit grants and connection
-- revocations.
--
-- 1. `opengeni_private.user_activity_presence` keeps one row per managed human
--    (`user:` subject only): when OpenGeni first and last saw an authenticated
--    browser session for them. API processes write it in throttled batches
--    through `record_user_activity_presence`; control workers read windowed
--    counts through `count_active_users` for the `opengeni_active_users`
--    gauges. API keys, services and embedded-host subjects never enter it.
-- 2. `opengeni_private.credit_grant_observations` mirrors one content-free row
--    per positive credit grant (`grant` or `manual_credit_grant` ledger rows)
--    with a bounded grant class, written by a ledger trigger, so a control
--    worker can publish grant totals that include grants written by database
--    triggers (the verified-signup trial) and operator tooling. It starts empty
--    at this migration: history stays in the ledger itself.
-- 3. Three new lifecycle fact types on the `lifecycle_fact` export:
--    `user.active` (at most once per person per UTC day), `credits.granted`
--    (attribute: grant class) and `connection.revoked` (attribute: provider
--    class, same list as `connection.created`).
--
-- This file touches no busy table. The new triggers on credit_ledger_entries
-- and connections (0566, 0567) and the backfill read policies (0568-0581, one
-- source table each) are separate short migrations with 1 second lock timeouts.
--
-- Nothing here reads or copies a name, email, domain, amount into a fact, or
-- free text. Every capture path is telemetry only and never fails the product
-- change that triggered it.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE IF NOT EXISTS opengeni_private.user_activity_presence (
  subject_id text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- The UTC day of last_seen_at. A change of day is the `user.active` fact.
  active_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  CONSTRAINT user_activity_presence_subject_check
    CHECK (subject_id ~ '^user:[A-Za-z0-9_-]{8,128}$'),
  CONSTRAINT user_activity_presence_order_check
    CHECK (first_seen_at <= last_seen_at)
);
CREATE INDEX IF NOT EXISTS user_activity_presence_last_seen_idx
  ON opengeni_private.user_activity_presence (last_seen_at);

CREATE TABLE IF NOT EXISTS opengeni_private.credit_grant_observations (
  ledger_entry_id uuid PRIMARY KEY,
  grant_class text NOT NULL,
  amount_micros bigint NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_grant_observations_class_check
    CHECK (grant_class IN ('signup_trial', 'coupon', 'manual', 'other')),
  CONSTRAINT credit_grant_observations_amount_check CHECK (amount_micros > 0)
);

-- Both tables are system-only: no runtime role ever receives table DML, and
-- FORCE RLS admits only the exact migration owner (also the SECURITY DEFINER
-- owner below), as for the host-export tables.
ALTER TABLE opengeni_private.user_activity_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.user_activity_presence FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.credit_grant_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.credit_grant_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE opengeni_private.user_activity_presence FROM PUBLIC;
REVOKE ALL ON TABLE opengeni_private.credit_grant_observations FROM PUBLIC;
DO $policies$
DECLARE owner_role text := current_user;
BEGIN
  DROP POLICY IF EXISTS usage_analytics_owner ON opengeni_private.user_activity_presence;
  EXECUTE format(
    'CREATE POLICY usage_analytics_owner ON opengeni_private.user_activity_presence '
      'USING (current_user = %L) WITH CHECK (current_user = %L)',
    owner_role, owner_role
  );
  DROP POLICY IF EXISTS usage_analytics_owner ON opengeni_private.credit_grant_observations;
  EXECUTE format(
    'CREATE POLICY usage_analytics_owner ON opengeni_private.credit_grant_observations '
      'USING (current_user = %L) WITH CHECK (current_user = %L)',
    owner_role, owner_role
  );
END $policies$;

-- Ledger grant row -> closed grant class. Keep in sync with
-- CREDIT_GRANT_CLASSES in packages/contracts/src/product-lifecycle-facts.ts.
CREATE OR REPLACE FUNCTION opengeni_private.credit_grant_class(
  p_type text,
  p_source_type text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN p_source_type = 'verified_signup_trial' THEN 'signup_trial'
    WHEN p_source_type = 'stripe_checkout_coupon' THEN 'coupon'
    WHEN p_type = 'manual_credit_grant' OR p_source_type = 'operator_adjustment' THEN 'manual'
    ELSE 'other'
  END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.credit_grant_class(text, text) FROM PUBLIC;

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
      'codex', 'supergrok', 'vercel_gateway', 'openrouter', 'anthropic', 'claude_subscription'
    )
    WHEN 'credits.purchased' THEN p_attribute IS NULL
    WHEN 'credits.granted' THEN p_attribute IN ('signup_trial', 'coupon', 'manual', 'other')
    WHEN 'connection.created' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'connection.revoked' THEN p_attribute IN (
      'slack', 'github', 'gitlab', 'azure_devops', 'bitbucket', 'google',
      'microsoft', 'linear', 'atlassian', 'notion', 'supabase', 'datadog',
      'posthog', 'openai', 'x', 'other'
    )
    WHEN 'scheduled_task.created' THEN p_attribute IS NULL
    WHEN 'skill.installed' THEN p_attribute IS NULL
    WHEN 'slack.user_linked' THEN p_attribute IS NULL
    WHEN 'machine.enrolled' THEN p_attribute IS NULL
    WHEN 'member.joined' THEN p_attribute IS NULL
    WHEN 'user.active' THEN p_attribute IS NULL
    ELSE false
  END, false)
$function$;

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  -- The 0532 capture function with three additions (a credit grant is not a
  -- purchase, a connection revocation or deletion is `connection.revoked`,
  -- and a new UTC day of presence is `user.active`). Each branch now selects
  -- its fact and one block writes it, so no separately callable writer
  -- exists, and a trigger fires only for the real source tables: a runtime
  -- role cannot attach this function to a temporary table of its own.
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
      v_fact_type text;
      v_attribute text;
      v_subject_id text;
      v_account_id uuid;
      v_workspace_id uuid;
      v_dedupe_key text;
      v_occurred_at timestamptz;
      v_exported_subject text;
      v_subject_kind text;
      v_initiator jsonb;
      v_source_id uuid;
      v_payload jsonb;
      v_inserted integer := 0;
    BEGIN
      IF TG_TABLE_SCHEMA NOT IN (%1$L, 'opengeni_private') THEN
        RETURN NULL;
      END IF;
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
              SELECT 'auth.sign_up',
                opengeni_private.product_lifecycle_auth_method(NEW.provider_id),
                'user:' || NEW.user_id, NULL, NULL, NEW.user_id
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            END IF;
          WHEN 'auth_users' THEN
            SELECT 'auth.email_verified', NULL, 'user:' || NEW.id, NULL, NULL, NEW.id
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
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
              SELECT 'auth.sign_in',
                opengeni_private.product_lifecycle_auth_method(v_provider),
                'user:' || NEW.user_id, NULL, NULL, NEW.id
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            END IF;
          WHEN 'self_service_organization_setup_receipts' THEN
            SELECT 'organization.setup', 'created', 'user:' || NEW.auth_user_id,
              NEW.account_id, NULL, NEW.account_id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'additional_organization_creation_receipts' THEN
            SELECT 'organization.setup', 'additional', NEW.actor_subject_id,
              NEW.account_id, NULL, NEW.account_id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'codex_subscription_credentials' THEN
            SELECT 'model.connected', 'codex', NEW.connected_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'xai_subscription_credentials' THEN
            SELECT 'model.connected', 'supergrok', NEW.connected_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'organization_model_provider_connections' THEN
            SELECT 'model.connected', NEW.provider_kind, NEW.updated_by_subject_id,
              NEW.account_id, NULL, NEW.id::text || ':' || NEW.operation_id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'credit_ledger_entries' THEN
            IF NEW.type = 'credit_topup' THEN
              SELECT 'credits.purchased', NULL, NULL,
                NEW.account_id, NULL, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            ELSE
              -- The verified-signup trial grant runs as the new owner, so its
              -- subject is that person; webhook and operator grants carry none.
              SELECT 'credits.granted',
                opengeni_private.credit_grant_class(NEW.type, NEW.source_type),
                opengeni_private.current_subject_id(),
                NEW.account_id, NULL, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            END IF;
          WHEN 'connections' THEN
            IF TG_OP = 'INSERT' THEN
              SELECT 'connection.created',
                opengeni_private.product_lifecycle_connection_class(NEW.provider_domain),
                NEW.created_by_subject_id, NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            ELSIF TG_OP = 'UPDATE' THEN
              -- Every revocation advances the connection version, so a
              -- reconnect-then-revoke is a second fact.
              SELECT 'connection.revoked',
                opengeni_private.product_lifecycle_connection_class(NEW.provider_domain),
                NEW.updated_by_subject_id, NEW.account_id, NEW.workspace_id,
                NEW.id::text || ':revoked:' || NEW.version::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            ELSE
              SELECT 'connection.revoked',
                opengeni_private.product_lifecycle_connection_class(OLD.provider_domain),
                opengeni_private.current_subject_id(), OLD.account_id, OLD.workspace_id,
                OLD.id::text || ':deleted'
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            END IF;
          WHEN 'scheduled_tasks' THEN
            SELECT 'scheduled_task.created', NULL, NEW.created_by_subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'skill_source_bindings' THEN
            SELECT 'skill.installed', NULL, opengeni_private.current_subject_id(),
              NEW.account_id, NEW.workspace_id, NEW.preference_id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'slack_bot_user_links' THEN
            SELECT 'slack.user_linked', NULL, NEW.subject_id,
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'enrollments' THEN
            SELECT 'machine.enrolled', NULL, opengeni_private.current_subject_id(),
              NEW.account_id, NEW.workspace_id, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          WHEN 'organization_memberships' THEN
            -- The founder's own membership is covered by organization.setup.
            IF EXISTS (
              SELECT 1 FROM %1$I.organization_memberships earlier
              WHERE earlier.account_id = NEW.account_id
                AND earlier.id <> NEW.id
                AND earlier.subject_id <> NEW.subject_id
                AND earlier.created_at <= NEW.created_at
            ) THEN
              SELECT 'member.joined', NULL, NEW.subject_id,
                NEW.account_id, NULL, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
            END IF;
          WHEN 'user_activity_presence' THEN
            -- A person belongs to no single organization, like a sign-in.
            SELECT 'user.active', NULL, NEW.subject_id, NULL, NULL,
              NEW.subject_id || ':' || NEW.active_day::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key;
          ELSE
            NULL;
        END CASE;

      -- Validate and write the one fact: a fixed type and attribute, a
      -- pseudonymous subject, and a deterministic name-based id.
      IF v_fact_type IS NOT NULL THEN
        SELECT c.lifecycle_facts_enabled INTO v_enabled
        FROM %1$I.host_export_config c WHERE c.id = 1
        FOR SHARE;
        IF coalesce(v_enabled, false) THEN
          IF NOT opengeni_private.product_lifecycle_fact_valid(v_fact_type, v_attribute) THEN
            RAISE EXCEPTION 'invalid product lifecycle fact' USING ERRCODE = '22023';
          END IF;
          IF v_dedupe_key IS NULL OR length(v_dedupe_key) NOT BETWEEN 1 AND 512 THEN
            RAISE EXCEPTION 'invalid product lifecycle fact key' USING ERRCODE = '22023';
          END IF;
          IF v_workspace_id IS NOT NULL AND v_account_id IS NULL THEN
            RAISE EXCEPTION 'product lifecycle workspace requires its organization'
              USING ERRCODE = '22023';
          END IF;
          v_exported_subject := CASE
            WHEN v_subject_id ~ '^(user|api_key):[A-Za-z0-9_-]{8,128}$' THEN v_subject_id
            ELSE NULL
          END;
          v_subject_kind := CASE
            WHEN nullif(btrim(coalesce(v_subject_id, '')), '') IS NULL THEN 'none'
            WHEN v_exported_subject IS NOT NULL AND starts_with(v_exported_subject, 'user:') THEN 'user'
            WHEN v_exported_subject IS NOT NULL THEN 'api_key'
            WHEN starts_with(v_subject_id, 'service:') THEN 'service'
            ELSE 'other'
          END;
          v_initiator := CASE
            WHEN v_exported_subject IS NULL THEN NULL
            ELSE jsonb_build_object('kind', 'subject', 'subjectId', v_exported_subject)
          END;
          v_source_id := overlay(overlay(md5(
            'opengeni-product-lifecycle-fact:v1:' || v_fact_type || ':' || v_dedupe_key
          ) placing '5' from 13) placing '8' from 17)::uuid;
          v_payload := jsonb_build_object(
            'factType', v_fact_type,
            'attribute', v_attribute,
            'subjectKind', v_subject_kind
          );
          INSERT INTO %1$I.host_export_outbox (
            export_kind, source_id, account_id, workspace_id, event_type,
            idempotency_key, initiator, initiator_context, origin, payload,
            envelope_bytes, occurred_at, source_recorded_at, enqueued_at
          ) VALUES (
            'lifecycle_fact', v_source_id, v_account_id, v_workspace_id, v_fact_type,
            'lifecycle_fact:' || v_source_id::text, v_initiator, '{}'::jsonb, NULL,
            v_payload,
            octet_length(v_payload::text)
              + octet_length(coalesce(v_initiator, 'null'::jsonb)::text) + 512,
            coalesce(v_occurred_at, clock_timestamp()), clock_timestamp(), clock_timestamp()
          )
          ON CONFLICT (export_kind, source_id) DO NOTHING;
          GET DIAGNOSTICS v_inserted = ROW_COUNT;
        END IF;
      END IF;
      EXCEPTION WHEN OTHERS THEN
        -- Telemetry only: roll back the fact, never the product change.
        RAISE WARNING 'product lifecycle fact capture skipped (%%)', SQLSTATE;
      END;
      RETURN NULL;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.capture_product_lifecycle_fact() FROM PUBLIC;

-- Mirror one content-free row per positive grant. Telemetry only: a failure
-- rolls back the observation, never the grant.
DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  -- Fires only for the real ledger, never a runtime role's temporary table.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.observe_credit_grant()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    BEGIN
      IF TG_TABLE_SCHEMA <> %1$L THEN
        RETURN NULL;
      END IF;
      BEGIN
        INSERT INTO opengeni_private.credit_grant_observations (
          ledger_entry_id, grant_class, amount_micros
        ) VALUES (
          NEW.id, opengeni_private.credit_grant_class(NEW.type, NEW.source_type),
          NEW.amount_micros
        )
        ON CONFLICT (ledger_entry_id) DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'credit grant observation skipped (%%)', SQLSTATE;
      END;
      RETURN NULL;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.observe_credit_grant() FROM PUBLIC;

-- The new triggers on the busy ledger and connections tables live in their
-- own short migrations (0566 and 0567).
DROP TRIGGER IF EXISTS product_lifecycle_fact_user_active
  ON opengeni_private.user_activity_presence;
CREATE TRIGGER product_lifecycle_fact_user_active
AFTER INSERT ON opengeni_private.user_activity_presence
FOR EACH ROW EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();
DROP TRIGGER IF EXISTS product_lifecycle_fact_user_active_day
  ON opengeni_private.user_activity_presence;
CREATE TRIGGER product_lifecycle_fact_user_active_day
AFTER UPDATE OF "active_day" ON opengeni_private.user_activity_presence
FOR EACH ROW WHEN (NEW.active_day IS DISTINCT FROM OLD.active_day)
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- Runtime capability: record that these managed humans were seen now. Input
-- outside the opaque `user:` shape is ignored, never stored. A row seen in the
-- last 30 seconds is left alone (several API pods may report the same person),
-- unless the UTC day changed.
CREATE OR REPLACE FUNCTION opengeni_private.record_user_activity_presence(
  p_subject_ids text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_written integer;
BEGIN
  IF p_subject_ids IS NULL OR cardinality(p_subject_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_subject_ids) > 1000 THEN
    RAISE EXCEPTION 'too many presence subjects' USING ERRCODE = '22023';
  END IF;
  INSERT INTO opengeni_private.user_activity_presence AS presence (
    subject_id, first_seen_at, last_seen_at, active_day
  )
  SELECT DISTINCT subject.id, now(), now(), (now() AT TIME ZONE 'UTC')::date
  FROM unnest(p_subject_ids) AS subject(id)
  WHERE subject.id ~ '^user:[A-Za-z0-9_-]{8,128}$'
  ORDER BY subject.id
  ON CONFLICT (subject_id) DO UPDATE
  SET last_seen_at = greatest(presence.last_seen_at, EXCLUDED.last_seen_at),
      active_day = greatest(presence.active_day, EXCLUDED.active_day)
  WHERE presence.last_seen_at < EXCLUDED.last_seen_at - interval '30 seconds'
    OR presence.active_day < EXCLUDED.active_day;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END $function$;

-- Runtime capability: distinct people seen in each fixed window.
CREATE OR REPLACE FUNCTION opengeni_private.count_active_users()
RETURNS TABLE (time_window text, user_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH recent AS (
    SELECT presence.last_seen_at
    FROM opengeni_private.user_activity_presence presence
    WHERE presence.last_seen_at >= now() - interval '30 days'
  )
  SELECT window_row.time_window,
    (SELECT count(*) FROM recent WHERE recent.last_seen_at >= now() - window_row.span)::bigint
  FROM (VALUES
    ('5m', interval '5 minutes'),
    ('15m', interval '15 minutes'),
    ('1h', interval '1 hour'),
    ('24h', interval '24 hours'),
    ('7d', interval '7 days'),
    ('30d', interval '30 days')
  ) AS window_row(time_window, span)
$function$;

-- Runtime capability: grant totals observed since this migration, by class.
-- Every class is returned, including zeroes.
CREATE OR REPLACE FUNCTION opengeni_private.credit_grant_totals()
RETURNS TABLE (grant_class text, grant_count bigint, granted_micros bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT class.name,
    count(observation.ledger_entry_id)::bigint,
    coalesce(sum(observation.amount_micros), 0)::bigint
  FROM (VALUES ('signup_trial'), ('coupon'), ('manual'), ('other')) AS class(name)
  LEFT JOIN opengeni_private.credit_grant_observations observation
    ON observation.grant_class = class.name
  GROUP BY class.name
  ORDER BY class.name
$function$;

REVOKE ALL ON FUNCTION opengeni_private.record_user_activity_presence(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.count_active_users() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.credit_grant_totals() FROM PUBLIC;

-- Existing runtime roles (every non-owner role that may write sessions) gain
-- the three capabilities now; provisionRoles converges roles created later.
DO $grants$
DECLARE recipient record;
BEGIN
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = current_schema() AND c.relname = 'sessions'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.record_user_activity_presence(text[]), '
        'opengeni_private.count_active_users(), opengeni_private.credit_grant_totals() TO %I',
      recipient.rolname
    );
  END LOOP;
END $grants$;

-- ---------------------------------------------------------------------------
-- One-time historical backfill of lifecycle facts.
--
-- Capture starts when the first lifecycle consumer registers, so product
-- history before that moment is missing from the export. The migration owner
-- calls `opengeni_private.backfill_product_lifecycle_facts(source, batch)` per
-- source until it reports completion; see `bun run db:backfill-lifecycle-facts`.
--
-- Every backfilled fact uses the same type, attribute rules and deterministic
-- dedupe key as its live trigger, so its fact id equals the id live capture
-- would have produced: an overlap with live capture conflicts in the outbox
-- and carries the same idempotency key at the sink. The original source
-- timestamp becomes `occurredAt`.
--
-- The first call for a source materializes its candidate facts once into a
-- private queue with one read of the source tables (ACCESS SHARE locks only);
-- every batch then pages that queue by its primary key. Source tables are never
-- altered at runtime: FORCE RLS stays on, and the owner reads them through
-- SELECT-only policies that open only while a transaction-local capability
-- row (backend pid + transaction id) written by the backfill itself exists.
-- Facts introduced by this migration whose source key could differ from live
-- capture (`connection.revoked`, `user.active`) only backfill rows older than
-- the moment their live capture really began: this migration, or the first
-- lifecycle consumer registration when that came later.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opengeni_private.product_lifecycle_backfill_progress (
  source text PRIMARY KEY,
  live_capture_from timestamptz,
  materialized_at timestamptz,
  materialized bigint NOT NULL DEFAULT 0,
  cursor_seq bigint NOT NULL DEFAULT 0,
  scanned bigint NOT NULL DEFAULT 0,
  enqueued bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS opengeni_private.product_lifecycle_backfill_queue (
  source text NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  fact_type text NOT NULL,
  attribute text,
  subject_id text,
  account_id uuid,
  workspace_id uuid,
  dedupe_key text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (source, seq)
);
CREATE TABLE IF NOT EXISTS opengeni_private.lifecycle_backfill_read_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  PRIMARY KEY (backend_pid, transaction_id)
);
DO $policies$
DECLARE owner_role text := current_user; table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'product_lifecycle_backfill_progress', 'product_lifecycle_backfill_queue',
    'lifecycle_backfill_read_capabilities'
  ] LOOP
    EXECUTE format('ALTER TABLE opengeni_private.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE opengeni_private.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE opengeni_private.%I FROM PUBLIC', table_name);
    EXECUTE format('DROP POLICY IF EXISTS usage_analytics_owner ON opengeni_private.%I', table_name);
    EXECUTE format(
      'CREATE POLICY usage_analytics_owner ON opengeni_private.%I '
        'USING (current_user = %L) WITH CHECK (current_user = %L)',
      table_name, owner_role, owner_role
    );
  END LOOP;
END $policies$;
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from)
SELECT source.name,
  CASE WHEN source.name IN ('connection.revoked', 'user.active') THEN now() END
FROM unnest(ARRAY[
  'auth.sign_up', 'auth.email_verified', 'auth.sign_in', 'organization.setup',
  'model.connected', 'credits.purchased', 'credits.granted', 'connection.created',
  'connection.revoked', 'scheduled_task.created', 'skill.installed',
  'slack.user_linked', 'machine.enrolled', 'member.joined', 'user.active'
]) AS source(name)
ON CONFLICT (source) DO NOTHING;

-- The read capability: true only inside the exact backend transaction that
-- wrote its row. Only the owner-run backfill writes rows, and removes its row
-- before returning, so no runtime role can ever make this true.
CREATE OR REPLACE FUNCTION opengeni_private.lifecycle_backfill_read_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.lifecycle_backfill_read_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
  )
$function$;

-- Runtime roles receive EXECUTE explicitly below and through provisionRoles;
-- restricted roles (artifact dispatcher/materializer) never do.
REVOKE ALL ON FUNCTION opengeni_private.lifecycle_backfill_read_active() FROM PUBLIC;

-- The SELECT-only read policies that this capability opens live in one short
-- migration per source table (0568 onward), so each table's ACCESS EXCLUSIVE
-- policy lock is held only for its own transaction.

DO $migration$
DECLARE target_schema text := current_schema(); owner_role text := current_user;
BEGIN

  -- The owner-only operator backfill. Each source query yields
  -- (fact_type, attribute, subject_id, account_id, workspace_id, dedupe_key,
  -- occurred_at) with the live trigger's exact attribute and dedupe-key rules;
  -- $1 is the live-capture boundary for the two new kinds.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.backfill_product_lifecycle_facts(
      p_source text,
      p_batch_size integer DEFAULT 500
    ) RETURNS TABLE (
      backfill_source text,
      enqueued_count integer,
      scanned_count integer,
      backfill_completed boolean
    )
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_enabled boolean;
      v_progress opengeni_private.product_lifecycle_backfill_progress%%ROWTYPE;
      v_registered_at timestamptz;
      v_boundary timestamptz;
      v_query text;
      v_row record;
      v_materialized bigint;
      v_scanned integer := 0;
      v_enqueued integer := 0;
      v_last_seq bigint;
      v_tables text[];
      v_table text;
      v_marker text;
      v_fact_type text;
      v_attribute text;
      v_subject_id text;
      v_account_id uuid;
      v_workspace_id uuid;
      v_dedupe_key text;
      v_occurred_at timestamptz;
      v_exported_subject text;
      v_subject_kind text;
      v_initiator jsonb;
      v_source_id uuid;
      v_payload jsonb;
      v_inserted integer := 0;
    BEGIN
      -- Operator-only: the login must be (a member of) the migration owner.
      IF NOT pg_has_role(session_user, %2$L, 'MEMBER') THEN
        RAISE EXCEPTION 'the lifecycle backfill runs only as the migration owner'
          USING ERRCODE = '42501';
      END IF;
      IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 10000 THEN
        RAISE EXCEPTION 'backfill batch size must be between 1 and 10000'
          USING ERRCODE = '22023';
      END IF;
      SELECT c.lifecycle_facts_enabled INTO v_enabled
      FROM %1$I.host_export_config c WHERE c.id = 1;
      IF coalesce(v_enabled, false) = false THEN
        RAISE EXCEPTION 'no enabled lifecycle_fact consumer is registered'
          USING ERRCODE = '55000';
      END IF;
      SELECT * INTO v_progress
      FROM opengeni_private.product_lifecycle_backfill_progress progress
      WHERE progress.source = p_source
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown lifecycle backfill source' USING ERRCODE = '22023';
      END IF;
      IF v_progress.completed_at IS NOT NULL THEN
        RETURN QUERY SELECT p_source, 0, 0, true;
        RETURN;
      END IF;

      -- Transaction-local capability for this call only: it opens the
      -- SELECT-only source policies (migrations 0568 onward). It is removed
      -- before returning.
      INSERT INTO opengeni_private.lifecycle_backfill_read_capabilities (
        backend_pid, transaction_id
      ) VALUES (pg_backend_pid(), pg_current_xact_id())
      ON CONFLICT DO NOTHING;

      IF v_progress.materialized_at IS NULL THEN
        -- Live capture of the new kinds began at this migration or at the
        -- first lifecycle consumer registration, whichever came later.
        SELECT min(consumer.created_at) INTO v_registered_at
        FROM %1$I.host_export_consumers consumer
        WHERE consumer.export_kind = 'lifecycle_fact';
        v_boundary := CASE WHEN v_progress.live_capture_from IS NULL THEN 'infinity'::timestamptz
          ELSE greatest(v_progress.live_capture_from, coalesce(v_registered_at, '-infinity'))
        END;
        v_query := CASE p_source
          WHEN 'auth.sign_up' THEN $q$
            SELECT 'auth.sign_up',
              opengeni_private.product_lifecycle_auth_method(first.provider_id),
              'user:' || first.user_id, NULL::uuid, NULL::uuid, first.user_id::text,
              first.created_at
            FROM (
              SELECT DISTINCT ON (identity.user_id) identity.user_id, identity.provider_id,
                identity.created_at
              FROM %1$I.auth_identities identity
              ORDER BY identity.user_id, identity.created_at, identity.id
            ) first
          $q$
          WHEN 'auth.email_verified' THEN $q$
            -- A social provider verified the address at creation; a verified
            -- email-password account is dated by its last update (approximate).
            SELECT 'auth.email_verified', NULL::text, 'user:' || person.id, NULL::uuid,
              NULL::uuid, person.id::text, coalesce((
                SELECT CASE WHEN identity.provider_id <> 'credential' THEN person.created_at END
                FROM %1$I.auth_identities identity
                WHERE identity.user_id = person.id
                ORDER BY identity.created_at, identity.id
                LIMIT 1
              ), person.updated_at)
            FROM %1$I.auth_users person
            WHERE person.email_verified
          $q$
          WHEN 'auth.sign_in' THEN $q$
            -- Discarded session-set provider sessions are created already expired.
            SELECT 'auth.sign_in',
              opengeni_private.product_lifecycle_auth_method(coalesce(binding.provider_id, (
                SELECT min(identity.provider_id) FROM %1$I.auth_identities identity
                WHERE identity.user_id = session.user_id HAVING count(*) = 1
              ))),
              'user:' || session.user_id, NULL::uuid, NULL::uuid, session.id::text,
              session.created_at
            FROM %1$I.auth_sessions session
            LEFT JOIN %1$I.canonical_human_login_bindings binding
              ON binding.id = session.login_binding_id
            WHERE session.expires_at > session.created_at + interval '1 minute'
          $q$
          WHEN 'organization.setup' THEN $q$
            SELECT 'organization.setup', 'created', 'user:' || receipt.auth_user_id,
              receipt.account_id, NULL::uuid, receipt.account_id::text, receipt.created_at
            FROM %1$I.self_service_organization_setup_receipts receipt
            UNION ALL
            SELECT 'organization.setup', 'additional', receipt.actor_subject_id,
              receipt.account_id, NULL::uuid, receipt.account_id::text, receipt.created_at
            FROM %1$I.additional_organization_creation_receipts receipt
          $q$
          WHEN 'model.connected' THEN $q$
            SELECT 'model.connected', 'codex', credential.connected_by_subject_id,
              credential.account_id, credential.workspace_id, credential.id::text,
              credential.created_at
            FROM %1$I.codex_subscription_credentials credential
            UNION ALL
            SELECT 'model.connected', 'supergrok', credential.connected_by_subject_id,
              credential.account_id, credential.workspace_id, credential.id::text,
              credential.created_at
            FROM %1$I.xai_subscription_credentials credential
            UNION ALL
            -- A provider row is connected by its first operation and by every
            -- operation that reactivates it after a revoke, as the live trigger.
            SELECT 'model.connected', operation.provider_kind, NULL::text,
              operation.account_id, NULL::uuid,
              connection.id::text || ':' || operation.operation_id::text,
              operation.created_at
            FROM (
              SELECT candidate.*, lag(candidate.result_status) OVER (
                PARTITION BY candidate.account_id, candidate.provider_kind
                ORDER BY candidate.created_at, candidate.id
              ) AS previous_status
              FROM %1$I.organization_model_provider_connection_operations candidate
            ) operation
            JOIN %1$I.organization_model_provider_connections connection
              ON connection.account_id = operation.account_id
              AND connection.provider_kind = operation.provider_kind
            WHERE operation.result_status = 'active'
              AND operation.previous_status IS DISTINCT FROM 'active'
          $q$
          WHEN 'credits.purchased' THEN $q$
            SELECT 'credits.purchased', NULL::text, NULL::text, entry.account_id, NULL::uuid,
              entry.id::text, entry.created_at
            FROM %1$I.credit_ledger_entries entry
            WHERE entry.type = 'credit_topup'
          $q$
          WHEN 'credits.granted' THEN $q$
            -- The trial grant ran as its new owner, whose id is its source id.
            SELECT 'credits.granted',
              opengeni_private.credit_grant_class(entry.type, entry.source_type),
              CASE WHEN entry.source_type = 'verified_signup_trial'
                THEN 'user:' || entry.source_id END,
              entry.account_id, NULL::uuid, entry.id::text, entry.created_at
            FROM %1$I.credit_ledger_entries entry
            WHERE entry.type IN ('grant', 'manual_credit_grant') AND entry.amount_micros > 0
          $q$
          WHEN 'connection.created' THEN $q$
            SELECT 'connection.created',
              opengeni_private.product_lifecycle_connection_class(connection.provider_domain),
              connection.created_by_subject_id, connection.account_id,
              connection.workspace_id, connection.id::text, connection.created_at
            FROM %1$I.connections connection
          $q$
          WHEN 'connection.revoked' THEN $q$
            SELECT 'connection.revoked',
              opengeni_private.product_lifecycle_connection_class(connection.provider_domain),
              connection.updated_by_subject_id, connection.account_id,
              connection.workspace_id,
              connection.id::text || ':revoked:' || connection.version::text,
              connection.updated_at
            FROM %1$I.connections connection
            WHERE connection.status = 'revoked' AND connection.updated_at < $1
          $q$
          WHEN 'scheduled_task.created' THEN $q$
            SELECT 'scheduled_task.created', NULL::text, task.created_by_subject_id,
              task.account_id, task.workspace_id, task.id::text, task.created_at
            FROM %1$I.scheduled_tasks task
          $q$
          WHEN 'skill.installed' THEN $q$
            SELECT 'skill.installed', NULL::text, preference.created_by_subject_id,
              binding.account_id, binding.workspace_id, binding.preference_id::text,
              preference.created_at
            FROM %1$I.skill_source_bindings binding
            JOIN %1$I.preference_registry_preferences preference
              ON preference.account_id = binding.account_id
              AND preference.id = binding.preference_id
          $q$
          WHEN 'slack.user_linked' THEN $q$
            SELECT 'slack.user_linked', NULL::text, link.subject_id, link.account_id,
              link.workspace_id, link.id::text, link.created_at
            FROM %1$I.slack_bot_user_links link
          $q$
          WHEN 'machine.enrolled' THEN $q$
            SELECT 'machine.enrolled', NULL::text, NULL::text, enrollment.account_id,
              enrollment.workspace_id, enrollment.id::text, enrollment.created_at
            FROM %1$I.enrollments enrollment
          $q$
          WHEN 'member.joined' THEN $q$
            -- A provisioning row never became a member; the founder is covered
            -- by organization.setup.
            SELECT 'member.joined', NULL::text, membership.subject_id,
              membership.account_id, NULL::uuid, membership.id::text, membership.created_at
            FROM %1$I.organization_memberships membership
            WHERE membership.status <> 'provisioning'
              AND EXISTS (
                SELECT 1 FROM %1$I.organization_memberships earlier
                WHERE earlier.account_id = membership.account_id
                  AND earlier.id <> membership.id
                  AND earlier.subject_id <> membership.subject_id
                  AND earlier.created_at <= membership.created_at
              )
          $q$
          WHEN 'user.active' THEN $q$
            -- Approximation from stored browser sessions: the UTC days on
            -- which a person signed in or a session was refreshed.
            SELECT 'user.active', NULL::text, 'user:' || activity.user_id, NULL::uuid,
              NULL::uuid, 'user:' || activity.user_id || ':' || activity.day::text,
              min(activity.at)
            FROM (
              SELECT session.user_id, session.created_at AS at,
                (session.created_at AT TIME ZONE 'UTC')::date AS day
              FROM %1$I.auth_sessions session
              WHERE session.expires_at > session.created_at + interval '1 minute'
              UNION ALL
              SELECT session.user_id, session.updated_at,
                (session.updated_at AT TIME ZONE 'UTC')::date
              FROM %1$I.auth_sessions session
              WHERE session.expires_at > session.created_at + interval '1 minute'
            ) activity
            WHERE activity.at < $1
              AND ('user:' || activity.user_id) ~ '^user:[A-Za-z0-9_-]{8,128}$'
            GROUP BY activity.user_id, activity.day
          $q$
          ELSE NULL
        END;
        IF v_query IS NULL THEN
          RAISE EXCEPTION 'unknown lifecycle backfill source' USING ERRCODE = '22023';
        END IF;

        -- Fail closed rather than complete with zero rows: every FORCE-RLS
        -- source table must carry the read policy, and each of its
        -- restrictive SELECT policies must admit the capability.
        v_tables := CASE p_source
          WHEN 'organization.setup' THEN ARRAY[
            'self_service_organization_setup_receipts',
            'additional_organization_creation_receipts'
          ]
          WHEN 'model.connected' THEN ARRAY[
            'codex_subscription_credentials', 'xai_subscription_credentials',
            'organization_model_provider_connections',
            'organization_model_provider_connection_operations'
          ]
          WHEN 'credits.purchased' THEN ARRAY['credit_ledger_entries']
          WHEN 'credits.granted' THEN ARRAY['credit_ledger_entries']
          WHEN 'connection.created' THEN ARRAY['connections']
          WHEN 'connection.revoked' THEN ARRAY['connections']
          WHEN 'scheduled_task.created' THEN ARRAY['scheduled_tasks']
          WHEN 'skill.installed' THEN ARRAY[
            'skill_source_bindings', 'preference_registry_preferences'
          ]
          WHEN 'slack.user_linked' THEN ARRAY['slack_bot_user_links']
          WHEN 'machine.enrolled' THEN ARRAY['enrollments']
          WHEN 'member.joined' THEN ARRAY['organization_memberships']
          ELSE ARRAY[]::text[]
        END;
        FOREACH v_table IN ARRAY v_tables LOOP
          IF NOT EXISTS (
            SELECT 1 FROM pg_policy policy
            WHERE policy.polrelid = format('%%I.%%I', %1$L, v_table)::regclass
              AND policy.polname = 'lifecycle_backfill_read'
          ) OR EXISTS (
            SELECT 1 FROM pg_policy policy
            WHERE policy.polrelid = format('%%I.%%I', %1$L, v_table)::regclass
              AND NOT policy.polpermissive
              AND policy.polcmd IN ('r', '*')
              AND position('lifecycle_backfill_read_active'
                IN coalesce(pg_get_expr(policy.polqual, policy.polrelid), '')) = 0
          ) THEN
            RAISE EXCEPTION 'lifecycle backfill read access is missing on %%', v_table
              USING ERRCODE = '55000';
          END IF;
        END LOOP;

        -- One read of the source tables, ACCESS SHARE only, under the
        -- transaction-local read capability opened above. Sign-in methods are
        -- read under the canonical identity lifecycle marker, exactly like the
        -- live sign-in capture. The statement is bounded by the caller's
        -- statement_timeout (the runner sets one).
        v_marker := current_setting('opengeni.canonical_human_identity_lifecycle', true);
        PERFORM set_config('opengeni.canonical_human_identity_lifecycle', 'active', true);
        EXECUTE
          'INSERT INTO opengeni_private.product_lifecycle_backfill_queue ('
            || 'source, fact_type, attribute, subject_id, account_id, workspace_id, '
            || 'dedupe_key, occurred_at) '
            || 'SELECT $2, candidate.* FROM (' || v_query || ') AS candidate('
            || 'fact_type, attribute, subject_id, account_id, workspace_id, dedupe_key, '
            || 'occurred_at) ORDER BY candidate.occurred_at, candidate.dedupe_key'
          USING v_boundary, p_source;
        GET DIAGNOSTICS v_materialized = ROW_COUNT;
        PERFORM set_config(
          'opengeni.canonical_human_identity_lifecycle', coalesce(v_marker, ''), true
        );
        UPDATE opengeni_private.product_lifecycle_backfill_progress progress
        SET materialized_at = clock_timestamp(), materialized = v_materialized,
            updated_at = clock_timestamp()
        WHERE progress.source = p_source;
      END IF;

      -- One primary-key page of the private queue.
      FOR v_row IN
        SELECT queued.* FROM opengeni_private.product_lifecycle_backfill_queue queued
        WHERE queued.source = p_source
        ORDER BY queued.seq
        LIMIT p_batch_size
      LOOP
        v_scanned := v_scanned + 1;
        v_last_seq := v_row.seq;
        v_fact_type := v_row.fact_type;
        v_attribute := v_row.attribute;
        v_subject_id := v_row.subject_id;
        v_account_id := v_row.account_id;
        v_workspace_id := v_row.workspace_id;
        v_dedupe_key := v_row.dedupe_key;
        v_occurred_at := v_row.occurred_at;
        v_inserted := 0;
        -- Validate and write the one fact: a fixed type and attribute, a
        -- pseudonymous subject, and a deterministic name-based id.
        IF v_fact_type IS NOT NULL THEN
          SELECT c.lifecycle_facts_enabled INTO v_enabled
          FROM %1$I.host_export_config c WHERE c.id = 1
          FOR SHARE;
          IF coalesce(v_enabled, false) THEN
            IF NOT opengeni_private.product_lifecycle_fact_valid(v_fact_type, v_attribute) THEN
              RAISE EXCEPTION 'invalid product lifecycle fact' USING ERRCODE = '22023';
            END IF;
            IF v_dedupe_key IS NULL OR length(v_dedupe_key) NOT BETWEEN 1 AND 512 THEN
              RAISE EXCEPTION 'invalid product lifecycle fact key' USING ERRCODE = '22023';
            END IF;
            IF v_workspace_id IS NOT NULL AND v_account_id IS NULL THEN
              RAISE EXCEPTION 'product lifecycle workspace requires its organization'
                USING ERRCODE = '22023';
            END IF;
            v_exported_subject := CASE
              WHEN v_subject_id ~ '^(user|api_key):[A-Za-z0-9_-]{8,128}$' THEN v_subject_id
              ELSE NULL
            END;
            v_subject_kind := CASE
              WHEN nullif(btrim(coalesce(v_subject_id, '')), '') IS NULL THEN 'none'
              WHEN v_exported_subject IS NOT NULL AND starts_with(v_exported_subject, 'user:') THEN 'user'
              WHEN v_exported_subject IS NOT NULL THEN 'api_key'
              WHEN starts_with(v_subject_id, 'service:') THEN 'service'
              ELSE 'other'
            END;
            v_initiator := CASE
              WHEN v_exported_subject IS NULL THEN NULL
              ELSE jsonb_build_object('kind', 'subject', 'subjectId', v_exported_subject)
            END;
            v_source_id := overlay(overlay(md5(
              'opengeni-product-lifecycle-fact:v1:' || v_fact_type || ':' || v_dedupe_key
            ) placing '5' from 13) placing '8' from 17)::uuid;
            v_payload := jsonb_build_object(
              'factType', v_fact_type,
              'attribute', v_attribute,
              'subjectKind', v_subject_kind
            );
            INSERT INTO %1$I.host_export_outbox (
              export_kind, source_id, account_id, workspace_id, event_type,
              idempotency_key, initiator, initiator_context, origin, payload,
              envelope_bytes, occurred_at, source_recorded_at, enqueued_at
            ) VALUES (
              'lifecycle_fact', v_source_id, v_account_id, v_workspace_id, v_fact_type,
              'lifecycle_fact:' || v_source_id::text, v_initiator, '{}'::jsonb, NULL,
              v_payload,
              octet_length(v_payload::text)
                + octet_length(coalesce(v_initiator, 'null'::jsonb)::text) + 512,
              coalesce(v_occurred_at, clock_timestamp()), clock_timestamp(), clock_timestamp()
            )
            ON CONFLICT (export_kind, source_id) DO NOTHING;
            GET DIAGNOSTICS v_inserted = ROW_COUNT;
          END IF;
        END IF;
        v_enqueued := v_enqueued + v_inserted;
      END LOOP;
      IF v_last_seq IS NOT NULL THEN
        DELETE FROM opengeni_private.product_lifecycle_backfill_queue queued
        WHERE queued.source = p_source AND queued.seq <= v_last_seq;
      END IF;

      DELETE FROM opengeni_private.lifecycle_backfill_read_capabilities capability
      WHERE capability.backend_pid = pg_backend_pid()
        AND capability.transaction_id = pg_current_xact_id();

      UPDATE opengeni_private.product_lifecycle_backfill_progress progress
      SET cursor_seq = coalesce(v_last_seq, progress.cursor_seq),
          scanned = progress.scanned + v_scanned,
          enqueued = progress.enqueued + v_enqueued,
          completed_at = CASE WHEN v_scanned < p_batch_size THEN clock_timestamp() END,
          updated_at = clock_timestamp()
      WHERE progress.source = p_source;
      RETURN QUERY SELECT p_source, v_enqueued, v_scanned, v_scanned < p_batch_size;
    END $function$;
  $create$, target_schema, owner_role);
END $migration$;

-- 0532's separately callable writer is gone: the capture trigger function
-- writes facts itself and refuses any table outside the real schemas, and the
-- backfill refuses any login but the migration owner. Runtime roles keep
-- EXECUTE on the remaining routines for now because the runtime posture of
-- already-running binaries requires it; new binaries list the trigger
-- functions and the backfill as owner-internal, and a later migration revokes
-- runtime EXECUTE on them once no older binary can run.
DROP FUNCTION IF EXISTS opengeni_private.enqueue_product_lifecycle_fact(
  text, text, text, uuid, uuid, text
);
REVOKE ALL ON FUNCTION opengeni_private.backfill_product_lifecycle_facts(text, integer)
  FROM PUBLIC;

-- Existing runtime roles keep EXECUTE on every new private routine so the
-- runtime posture of running binaries is unchanged; provisionRoles converges
-- roles created later.
DO $grants$
DECLARE recipient record;
BEGIN
  FOR recipient IN
    SELECT DISTINCT r.rolname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = current_schema() AND c.relname = 'sessions'
      AND acl.privilege_type = 'INSERT' AND acl.grantee <> c.relowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION '
        'opengeni_private.credit_grant_class(text, text), '
        'opengeni_private.observe_credit_grant(), '
        'opengeni_private.lifecycle_backfill_read_active(), '
        'opengeni_private.backfill_product_lifecycle_facts(text, integer) TO %I',
      recipient.rolname
    );
  END LOOP;
END $grants$;
