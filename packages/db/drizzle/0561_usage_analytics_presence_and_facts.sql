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
  -- Same capture function as 0532 with three additions: the credit ledger
  -- distinguishes a purchase from a grant, a connection revocation or
  -- deletion is a `connection.revoked` fact, and a new UTC day of presence is
  -- a `user.active` fact. Every other branch is byte-for-byte unchanged.
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
            IF NEW.type = 'credit_topup' THEN
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'credits.purchased', NULL, NULL,
                NEW.account_id, NULL, NEW.id::text
              );
            ELSE
              -- The verified-signup trial grant runs as the new owner, so its
              -- subject is that person; webhook and operator grants carry none.
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'credits.granted',
                opengeni_private.credit_grant_class(NEW.type, NEW.source_type),
                opengeni_private.current_subject_id(),
                NEW.account_id, NULL, NEW.id::text
              );
            END IF;
          WHEN 'connections' THEN
            IF TG_OP = 'INSERT' THEN
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'connection.created',
                opengeni_private.product_lifecycle_connection_class(NEW.provider_domain),
                NEW.created_by_subject_id, NEW.account_id, NEW.workspace_id, NEW.id::text
              );
            ELSIF TG_OP = 'UPDATE' THEN
              -- Every revocation advances the connection version, so a
              -- reconnect-then-revoke is a second fact.
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'connection.revoked',
                opengeni_private.product_lifecycle_connection_class(NEW.provider_domain),
                NEW.updated_by_subject_id, NEW.account_id, NEW.workspace_id,
                NEW.id::text || ':revoked:' || NEW.version::text
              );
            ELSE
              PERFORM opengeni_private.enqueue_product_lifecycle_fact(
                'connection.revoked',
                opengeni_private.product_lifecycle_connection_class(OLD.provider_domain),
                opengeni_private.current_subject_id(), OLD.account_id, OLD.workspace_id,
                OLD.id::text || ':deleted'
              );
            END IF;
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
          WHEN 'user_activity_presence' THEN
            -- A person belongs to no single organization, like a sign-in.
            PERFORM opengeni_private.enqueue_product_lifecycle_fact(
              'user.active', NULL, NEW.subject_id, NULL, NULL,
              NEW.subject_id || ':' || NEW.active_day::text
            );
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
REVOKE ALL ON FUNCTION opengeni_private.capture_product_lifecycle_fact() FROM PUBLIC;

-- Mirror one content-free row per positive grant. Telemetry only: a failure
-- rolls back the observation, never the grant.
CREATE OR REPLACE FUNCTION opengeni_private.observe_credit_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  BEGIN
    INSERT INTO opengeni_private.credit_grant_observations (
      ledger_entry_id, grant_class, amount_micros
    ) VALUES (
      NEW.id, opengeni_private.credit_grant_class(NEW.type, NEW.source_type), NEW.amount_micros
    )
    ON CONFLICT (ledger_entry_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'credit grant observation skipped (%)', SQLSTATE;
  END;
  RETURN NULL;
END $function$;
REVOKE ALL ON FUNCTION opengeni_private.observe_credit_grant() FROM PUBLIC;

DROP TRIGGER IF EXISTS credit_grant_observation ON "credit_ledger_entries";
CREATE TRIGGER credit_grant_observation
AFTER INSERT ON "credit_ledger_entries"
FOR EACH ROW WHEN (NEW.type IN ('grant', 'manual_credit_grant') AND NEW.amount_micros > 0)
EXECUTE FUNCTION opengeni_private.observe_credit_grant();

DROP TRIGGER IF EXISTS product_lifecycle_fact_credits_granted ON "credit_ledger_entries";
CREATE TRIGGER product_lifecycle_fact_credits_granted
AFTER INSERT ON "credit_ledger_entries"
FOR EACH ROW WHEN (NEW.type IN ('grant', 'manual_credit_grant') AND NEW.amount_micros > 0)
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

DROP TRIGGER IF EXISTS product_lifecycle_fact_connection_revoked ON "connections";
CREATE TRIGGER product_lifecycle_fact_connection_revoked
AFTER UPDATE OF "status" ON "connections"
FOR EACH ROW WHEN (NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- Deleting a live connection removes it just as a revocation does; a row that
-- was already revoked was counted when it was revoked.
DROP TRIGGER IF EXISTS product_lifecycle_fact_connection_deleted ON "connections";
CREATE TRIGGER product_lifecycle_fact_connection_deleted
AFTER DELETE ON "connections"
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM 'revoked')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

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
-- history before that moment is missing from the export. An operator (the
-- migration owner or the host-export role) calls
-- `opengeni_host_export.backfill_product_lifecycle_facts(source, batch)` per
-- source until it reports `completed`; see `bun run db:backfill-lifecycle-facts`.
--
-- Every backfilled fact uses the same type, attribute rules and deterministic
-- dedupe key as its live trigger, so its fact id equals the id live capture
-- would have produced: an overlap with live capture conflicts in the outbox
-- (and carries the same idempotency key at the sink). The original source
-- timestamp becomes `occurredAt`. Progress is a durable keyset cursor per
-- source, so a re-run after completion enqueues nothing. Facts introduced by
-- this migration whose key could differ from live capture
-- (`connection.revoked`, `user.active`) only backfill source rows older than
-- the moment this migration started live capture for them.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS opengeni_private.product_lifecycle_backfill_progress (
  source text PRIMARY KEY,
  live_capture_from timestamptz,
  cursor_at timestamptz NOT NULL DEFAULT '-infinity',
  cursor_id text NOT NULL DEFAULT '',
  scanned bigint NOT NULL DEFAULT 0,
  enqueued bigint NOT NULL DEFAULT 0,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE opengeni_private.product_lifecycle_backfill_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.product_lifecycle_backfill_progress FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE opengeni_private.product_lifecycle_backfill_progress FROM PUBLIC;
DO $policies$
DECLARE owner_role text := current_user;
BEGIN
  DROP POLICY IF EXISTS usage_analytics_owner
    ON opengeni_private.product_lifecycle_backfill_progress;
  EXECUTE format(
    'CREATE POLICY usage_analytics_owner ON opengeni_private.product_lifecycle_backfill_progress '
      'USING (current_user = %L) WITH CHECK (current_user = %L)',
    owner_role, owner_role
  );
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

DO $migration$
DECLARE target_schema text := current_schema();
BEGIN
  -- enqueue_product_lifecycle_fact with an explicit occurrence time. Same
  -- gate, validation, subject reduction and deterministic id.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.enqueue_product_lifecycle_fact_at(
      p_fact_type text,
      p_attribute text,
      p_subject_id text,
      p_account_id uuid,
      p_workspace_id uuid,
      p_dedupe_key text,
      p_occurred_at timestamptz
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
        coalesce(p_occurred_at, clock_timestamp()), clock_timestamp(), clock_timestamp()
      )
      ON CONFLICT (export_kind, source_id) DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      RETURN v_inserted = 1;
    END $function$;
  $create$, target_schema);

  -- The operator backfill. Each source query yields
  -- (sort_at, sort_id, fact_type, attribute, subject_id, account_id,
  -- workspace_id, dedupe_key, occurred_at) with the live trigger's exact
  -- attribute and dedupe-key rules.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_host_export.backfill_product_lifecycle_facts(
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
      v_tables text[];
      v_table text;
      v_query text;
      v_row record;
      v_scanned integer := 0;
      v_enqueued integer := 0;
      v_last_at timestamptz;
      v_last_id text;
    BEGIN
      IF p_batch_size IS NULL OR p_batch_size NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'backfill batch size must be between 1 and 5000'
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

      v_tables := CASE p_source
        WHEN 'auth.sign_in' THEN ARRAY['canonical_human_login_bindings']
        WHEN 'organization.setup' THEN ARRAY[
          'self_service_organization_setup_receipts', 'additional_organization_creation_receipts'
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
        WHEN 'user.active' THEN ARRAY['session_turns']
        ELSE ARRAY[]::text[]
      END;

      v_query := CASE p_source
        WHEN 'auth.sign_up' THEN $q$
          SELECT first.created_at AS sort_at, first.user_id::text AS sort_id,
            'auth.sign_up'::text AS fact_type,
            opengeni_private.product_lifecycle_auth_method(first.provider_id) AS attribute,
            'user:' || first.user_id AS subject_id, NULL::uuid AS account_id,
            NULL::uuid AS workspace_id, first.user_id::text AS dedupe_key,
            first.created_at AS occurred_at
          FROM (
            SELECT DISTINCT ON (identity.user_id) identity.user_id, identity.provider_id,
              identity.created_at
            FROM %1$I.auth_identities identity
            ORDER BY identity.user_id, identity.created_at, identity.id
          ) first
        $q$
        WHEN 'auth.email_verified' THEN $q$
          SELECT verified.at, verified.id, 'auth.email_verified', NULL::text,
            'user:' || verified.id, NULL::uuid, NULL::uuid, verified.id, verified.at
          FROM (
            -- A social provider verified the address at creation; a verified
            -- email-password account is dated by its last update (approximate).
            SELECT person.id::text AS id, coalesce((
              SELECT CASE WHEN identity.provider_id <> 'credential' THEN person.created_at END
              FROM %1$I.auth_identities identity
              WHERE identity.user_id = person.id
              ORDER BY identity.created_at, identity.id
              LIMIT 1
            ), person.updated_at) AS at
            FROM %1$I.auth_users person
            WHERE person.email_verified
          ) verified
        $q$
        WHEN 'auth.sign_in' THEN $q$
          -- Discarded session-set provider sessions are created already expired.
          SELECT session.created_at, session.id::text, 'auth.sign_in',
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
          SELECT receipt.created_at, receipt.account_id::text, 'organization.setup',
            'created', 'user:' || receipt.auth_user_id, receipt.account_id, NULL::uuid,
            receipt.account_id::text, receipt.created_at
          FROM %1$I.self_service_organization_setup_receipts receipt
          UNION ALL
          SELECT receipt.created_at, receipt.account_id::text, 'organization.setup',
            'additional', receipt.actor_subject_id, receipt.account_id, NULL::uuid,
            receipt.account_id::text, receipt.created_at
          FROM %1$I.additional_organization_creation_receipts receipt
        $q$
        WHEN 'model.connected' THEN $q$
          SELECT credential.created_at, 'codex:' || credential.id, 'model.connected',
            'codex', credential.connected_by_subject_id, credential.account_id,
            credential.workspace_id, credential.id::text, credential.created_at
          FROM %1$I.codex_subscription_credentials credential
          UNION ALL
          SELECT credential.created_at, 'xai:' || credential.id, 'model.connected',
            'supergrok', credential.connected_by_subject_id, credential.account_id,
            credential.workspace_id, credential.id::text, credential.created_at
          FROM %1$I.xai_subscription_credentials credential
          UNION ALL
          -- A provider row is connected by its first operation and by every
          -- operation that reactivates it after a revoke, as the live trigger.
          SELECT operation.created_at, 'provider:' || operation.id, 'model.connected',
            operation.provider_kind, NULL::text, operation.account_id, NULL::uuid,
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
          SELECT entry.created_at, entry.id::text, 'credits.purchased', NULL::text,
            NULL::text, entry.account_id, NULL::uuid, entry.id::text, entry.created_at
          FROM %1$I.credit_ledger_entries entry
          WHERE entry.type = 'credit_topup'
        $q$
        WHEN 'credits.granted' THEN $q$
          -- The trial grant ran as its new owner, whose id is its source id.
          SELECT entry.created_at, entry.id::text, 'credits.granted',
            opengeni_private.credit_grant_class(entry.type, entry.source_type),
            CASE WHEN entry.source_type = 'verified_signup_trial'
              THEN 'user:' || entry.source_id END,
            entry.account_id, NULL::uuid, entry.id::text, entry.created_at
          FROM %1$I.credit_ledger_entries entry
          WHERE entry.type IN ('grant', 'manual_credit_grant') AND entry.amount_micros > 0
        $q$
        WHEN 'connection.created' THEN $q$
          SELECT connection.created_at, connection.id::text, 'connection.created',
            opengeni_private.product_lifecycle_connection_class(connection.provider_domain),
            connection.created_by_subject_id, connection.account_id, connection.workspace_id,
            connection.id::text, connection.created_at
          FROM %1$I.connections connection
        $q$
        WHEN 'connection.revoked' THEN $q$
          SELECT connection.updated_at, connection.id::text, 'connection.revoked',
            opengeni_private.product_lifecycle_connection_class(connection.provider_domain),
            connection.updated_by_subject_id, connection.account_id, connection.workspace_id,
            connection.id::text || ':revoked:' || connection.version::text,
            connection.updated_at
          FROM %1$I.connections connection
          WHERE connection.status = 'revoked' AND connection.updated_at < $4
        $q$
        WHEN 'scheduled_task.created' THEN $q$
          SELECT task.created_at, task.id::text, 'scheduled_task.created', NULL::text,
            task.created_by_subject_id, task.account_id, task.workspace_id, task.id::text,
            task.created_at
          FROM %1$I.scheduled_tasks task
        $q$
        WHEN 'skill.installed' THEN $q$
          SELECT preference.created_at, binding.preference_id::text, 'skill.installed',
            NULL::text, preference.created_by_subject_id, binding.account_id,
            binding.workspace_id, binding.preference_id::text, preference.created_at
          FROM %1$I.skill_source_bindings binding
          JOIN %1$I.preference_registry_preferences preference
            ON preference.account_id = binding.account_id
            AND preference.id = binding.preference_id
        $q$
        WHEN 'slack.user_linked' THEN $q$
          SELECT link.created_at, link.id::text, 'slack.user_linked', NULL::text,
            link.subject_id, link.account_id, link.workspace_id, link.id::text, link.created_at
          FROM %1$I.slack_bot_user_links link
        $q$
        WHEN 'machine.enrolled' THEN $q$
          SELECT enrollment.created_at, enrollment.id::text, 'machine.enrolled', NULL::text,
            NULL::text, enrollment.account_id, enrollment.workspace_id, enrollment.id::text,
            enrollment.created_at
          FROM %1$I.enrollments enrollment
        $q$
        WHEN 'member.joined' THEN $q$
          -- A provisioning row never became a member; the founder is covered
          -- by organization.setup.
          SELECT membership.created_at, membership.id::text, 'member.joined', NULL::text,
            membership.subject_id, membership.account_id, NULL::uuid, membership.id::text,
            membership.created_at
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
          -- Approximation: a day on which the person started a turn.
          SELECT min(turn.created_at), turn.initiating_human_subject_id || ':'
              || ((turn.created_at AT TIME ZONE 'UTC')::date)::text,
            'user.active', NULL::text, turn.initiating_human_subject_id, NULL::uuid,
            NULL::uuid, turn.initiating_human_subject_id || ':'
              || ((turn.created_at AT TIME ZONE 'UTC')::date)::text,
            min(turn.created_at)
          FROM %1$I.session_turns turn
          WHERE turn.initiating_human_subject_id ~ '^user:[A-Za-z0-9_-]{8,128}$'
            AND turn.created_at < $4
          GROUP BY turn.initiating_human_subject_id, (turn.created_at AT TIME ZONE 'UTC')::date
        $q$
        ELSE NULL
      END;
      IF v_query IS NULL THEN
        RAISE EXCEPTION 'unknown lifecycle backfill source' USING ERRCODE = '22023';
      END IF;

      -- FORCE ROW LEVEL SECURITY binds this owner too, so open the owner-only
      -- window on exactly the source tables for this transaction. Runtime
      -- roles stay policy-bound; the window closes before returning and rolls
      -- back with any failure. A short lock timeout keeps a busy table from
      -- queueing production writers behind the backfill.
      PERFORM set_config('lock_timeout', '3s', true);
      FOREACH v_table IN ARRAY v_tables LOOP
        EXECUTE format('ALTER TABLE %%I.%%I NO FORCE ROW LEVEL SECURITY', %1$L, v_table);
      END LOOP;

      FOR v_row IN EXECUTE
        'SELECT * FROM (' || v_query || ') AS source_rows('
          || 'sort_at, sort_id, fact_type, attribute, subject_id, account_id, '
          || 'workspace_id, dedupe_key, occurred_at) '
          || 'WHERE (source_rows.sort_at, source_rows.sort_id) > ($1, $2) '
          || 'ORDER BY source_rows.sort_at, source_rows.sort_id LIMIT $3'
        USING v_progress.cursor_at, v_progress.cursor_id, p_batch_size,
          coalesce(v_progress.live_capture_from, 'infinity'::timestamptz)
      LOOP
        v_scanned := v_scanned + 1;
        v_last_at := v_row.sort_at;
        v_last_id := v_row.sort_id;
        IF opengeni_private.enqueue_product_lifecycle_fact_at(
          v_row.fact_type, v_row.attribute, v_row.subject_id, v_row.account_id,
          v_row.workspace_id, v_row.dedupe_key, v_row.occurred_at
        ) THEN
          v_enqueued := v_enqueued + 1;
        END IF;
      END LOOP;

      FOREACH v_table IN ARRAY v_tables LOOP
        EXECUTE format('ALTER TABLE %%I.%%I FORCE ROW LEVEL SECURITY', %1$L, v_table);
      END LOOP;

      UPDATE opengeni_private.product_lifecycle_backfill_progress progress
      SET cursor_at = coalesce(v_last_at, progress.cursor_at),
          cursor_id = coalesce(v_last_id, progress.cursor_id),
          scanned = progress.scanned + v_scanned,
          enqueued = progress.enqueued + v_enqueued,
          completed_at = CASE WHEN v_scanned < p_batch_size THEN clock_timestamp() END,
          updated_at = clock_timestamp()
      WHERE progress.source = p_source;
      RETURN QUERY SELECT p_source, v_enqueued, v_scanned, v_scanned < p_batch_size;
    END $function$;
  $create$, target_schema);
END $migration$;
REVOKE ALL ON FUNCTION opengeni_private.enqueue_product_lifecycle_fact_at(
  text, text, text, uuid, uuid, text, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_host_export.backfill_product_lifecycle_facts(text, integer)
  FROM PUBLIC;
-- Host-export roles that already manage consumers may run the backfill;
-- provisionRoles converges roles created later (EXECUTE on that schema).
DO $grants$
DECLARE recipient record;
BEGIN
  FOR recipient IN
    SELECT DISTINCT r.rolname
    FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) acl
      JOIN pg_roles r ON r.oid = acl.grantee
    WHERE n.nspname = 'opengeni_host_export'
      AND p.proname = 'register_host_export_consumer'
      AND acl.privilege_type = 'EXECUTE' AND acl.grantee <> p.proowner
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_host_export.backfill_product_lifecycle_facts(text, integer) TO %I',
      recipient.rolname
    );
  END LOOP;
END $grants$;
