-- deployment-mode: rolling
-- contract-step: after PRs #6710 (including the Codex source sidecar), #6714 and #6725 have shipped and the previous-production readiness baseline has advanced separately. PR #6436 removed the provider-specific runtime. Current subscription connections, authorities, leases and frozen snapshots remain unchanged.
-- No CASCADE and no mutation of accepted turn/task/history authority.
-- online-safety-exception: unbatched-data: Retired credential sources have no remaining writers; the owner-visible preflight bounds their combined population before preserving historical backfill inputs atomically with contraction.
SET LOCAL lock_timeout = '5s';

-- Serialize with the historical fact backfill before locking its sources.
-- Its row lock precedes source reads too. Owner-only windows are transactional;
-- they never open runtime access, and every failure restores FORCE RLS.
ALTER TABLE opengeni_private.product_lifecycle_backfill_progress NO FORCE ROW LEVEL SECURITY;
SELECT source FROM opengeni_private.product_lifecycle_backfill_progress
WHERE source = 'model.connected' FOR UPDATE;
ALTER TABLE opengeni_private.product_lifecycle_backfill_queue NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_credential_leases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_rotation_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_session_account_pins NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_subscription_account_usage NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claude_subscription_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_apps_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_credential_leases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_rotation_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_subscription_credentials NO FORCE ROW LEVEL SECURITY;
ALTER TABLE codex_turn_source_bindings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_codex_rotation_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_provider_cutovers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_codex_subscription_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_credential_leases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_rotation_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_session_account_pins NO FORCE ROW LEVEL SECURITY;
ALTER TABLE xai_subscription_credentials NO FORCE ROW LEVEL SECURITY;

DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM codex_credential_leases WHERE leased_until > clock_timestamp())
    OR EXISTS (SELECT 1 FROM claude_credential_leases WHERE leased_until > clock_timestamp())
    OR EXISTS (SELECT 1 FROM xai_credential_leases WHERE leased_until > clock_timestamp())
  THEN
    RAISE EXCEPTION 'legacy subscription leases must drain before contraction'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM opengeni_private.product_lifecycle_backfill_progress
    WHERE source = 'model.connected') THEN
    RAISE EXCEPTION 'model connection backfill progress must exist before contraction'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM codex_subscription_credentials)
    + (SELECT count(*) FROM xai_subscription_credentials) > 10000 THEN
    RAISE EXCEPTION 'large retired credential history requires batched preservation before contraction'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

-- If these inputs were not materialized already, retain precisely the old
-- backfill's two legacy sources in its existing queue, even without a consumer.
-- The current-source materialization later appends to this same queue. Existing
-- materialized/completed backfills and outbox receipts are not rewritten.
INSERT INTO opengeni_private.product_lifecycle_backfill_queue
  (source, fact_type, attribute, subject_id, account_id, workspace_id, dedupe_key, occurred_at)
SELECT 'model.connected', 'model.connected', 'codex', credential.connected_by_subject_id,
  credential.account_id, credential.workspace_id, credential.id::text, credential.created_at
FROM codex_subscription_credentials credential
WHERE EXISTS (SELECT 1 FROM opengeni_private.product_lifecycle_backfill_progress
  WHERE source = 'model.connected' AND materialized_at IS NULL AND completed_at IS NULL)
UNION ALL
SELECT 'model.connected', 'model.connected', 'supergrok', credential.connected_by_subject_id,
  credential.account_id, credential.workspace_id, credential.id::text, credential.created_at
FROM xai_subscription_credentials credential
WHERE EXISTS (SELECT 1 FROM opengeni_private.product_lifecycle_backfill_progress
  WHERE source = 'model.connected' AND materialized_at IS NULL AND completed_at IS NULL);
ALTER TABLE opengeni_private.product_lifecycle_backfill_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.product_lifecycle_backfill_progress FORCE ROW LEVEL SECURITY;

DO $install$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.backfill_product_lifecycle_facts(p_source text, p_batch_size integer DEFAULT 500)
 RETURNS TABLE(backfill_source text, enqueued_count integer, scanned_count integer, backfill_completed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
        -- Include historical inputs preserved before their source tables retired.
        SELECT count(*) INTO v_materialized
        FROM opengeni_private.product_lifecycle_backfill_queue queued
        WHERE queued.source = p_source;
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
    END $function$

$create$, data_schema, current_user);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.capture_product_lifecycle_fact()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
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
          WHEN 'subscription_connections' THEN
            SELECT 'model.connected', attribute.value, NEW.connected_by_subject_id,
              NEW.account_id, NULL, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key
            FROM (VALUES ('codex', 'codex'), ('xai', 'supergrok'),
              ('claude', 'claude_subscription')) attribute(provider, value)
            WHERE attribute.provider = NEW.provider;
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
    END $function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION opengeni_private.check_organization_tenancy_parity_pre_0340(p_organization_id uuid, p_evidence_limit integer DEFAULT 10, p_observation_window_days integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO '$user', %1$L
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  result jsonb;
  evidence_limit integer := least(greatest(coalesce(p_evidence_limit, 10), 0), 50);
  window_days integer := least(greatest(coalesce(p_observation_window_days, 30), 1), 365);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy parity check requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy parity scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_parity_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  WITH gate_catalog(gate_id) AS (
    VALUES
      ('membership_personal_workspace_pointer'::text),
      ('membership_personal_workspace_exclusive'),
      ('membership_personal_workspace_same_organization'),
      ('personal_workspace_has_no_membership_row'),
      ('authority_resource_single_owner'),
      ('grant_delegation_fence_complete'),
      ('grant_owner_membership_active'),
      ('grant_authority_live'),
      ('grant_session_fence_not_ahead'),
      ('session_owner_provenance_paired'),
      ('session_owner_subject_matches_membership'),
      ('session_owner_membership_same_organization'),
      ('login_binding_dispute_propagated'),
      ('identity_active_binding_owned'),
      ('user_scoped_resource_live_anchor')
  ),
  -- Canonical human identities are organization-INDEPENDENT by design, so an
  -- organization-scoped parity report may only inspect the identities that
  -- actually anchor a subject of THIS organization. `user:<auth_user_id>` is
  -- the canonical subject encoding used by organization_memberships.
  scoped_identities AS (
    SELECT DISTINCT identity_subject.identity_id
    FROM canonical_human_identity_subjects identity_subject
    JOIN organization_memberships membership
      ON membership.account_id = p_organization_id
     AND membership.subject_id = 'user:' || identity_subject.auth_user_id
  ),
  violations(gate_id, evidence_id) AS (
    -- An active membership must identify a personal workspace.
    SELECT 'membership_personal_workspace_pointer'::text, membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.status = 'active'
      AND membership.personal_workspace_id IS NULL

    UNION ALL
    -- A personal workspace may identify at most one organization membership.
    SELECT 'membership_personal_workspace_exclusive', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM organization_memberships other
        WHERE other.account_id = p_organization_id
          AND other.id <> membership.id
          AND other.personal_workspace_id = membership.personal_workspace_id
      )

    UNION ALL
    -- The personal workspace must belong to the same organization.
    SELECT 'membership_personal_workspace_same_organization', membership.id
    FROM organization_memberships membership
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces workspace
        WHERE workspace.id = membership.personal_workspace_id
          AND workspace.account_id = p_organization_id
      )

    UNION ALL
    -- A managed personal workspace deliberately has NO workspace_memberships
    -- row: the owner-only access projection is derived, not delegable. A
    -- persisted row there is precisely how membership CRUD and the subject-
    -- membership fallback would widen it. Evidence is the workspace id.
    SELECT DISTINCT 'personal_workspace_has_no_membership_row',
      membership.personal_workspace_id
    FROM organization_memberships membership
    JOIN workspace_memberships workspace_membership
      ON workspace_membership.account_id = p_organization_id
     AND workspace_membership.workspace_id = membership.personal_workspace_id
    WHERE membership.account_id = p_organization_id
      AND membership.personal_workspace_id IS NOT NULL

    UNION ALL
    -- Stable authority uniqueness. The physical unique index is per
    -- (account, membership, kind, resource), so two DIFFERENT memberships can
    -- still claim the same resource - the ambiguity that must never be
    -- resolved toward either user.
    SELECT 'authority_resource_single_owner', authority.id
    FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_organization_id
      AND authority.status <> 'revoked'
      AND EXISTS (
        SELECT 1 FROM organization_user_resource_authorities rival
        WHERE rival.account_id = p_organization_id
          AND rival.status <> 'revoked'
          AND rival.resource_kind = authority.resource_kind
          AND rival.resource_id = authority.resource_id
          AND rival.organization_membership_id
            <> authority.organization_membership_id
      )

    UNION ALL
    -- Zero partial delegations: `always` carries neither fence, once/session
    -- carry both.
    SELECT 'grant_delegation_fence_complete', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    WHERE resource_grant.account_id = p_organization_id
      AND NOT (
        (resource_grant.mode = 'always'
          AND resource_grant.session_id IS NULL
          AND resource_grant.authority_epoch IS NULL)
        OR (resource_grant.mode IN ('once', 'session')
          AND resource_grant.session_id IS NOT NULL
          AND resource_grant.authority_epoch IS NOT NULL
          AND resource_grant.authority_epoch > 0)
      )

    UNION ALL
    -- A live personal delegation owned by a human whose organization
    -- membership is suspended or revoked is a fallback to user authority.
    -- Suspension revokes personal-resource grants and offboarding runs the
    -- same teardown, so the drained state is the normal one.
    SELECT 'grant_owner_membership_active', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_memberships membership
      ON membership.id = resource_grant.owner_organization_membership_id
     AND membership.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND membership.status <> 'active'

    UNION ALL
    -- An active grant over a revoked authority.
    SELECT 'grant_authority_live', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN organization_user_resource_authorities authority
      ON authority.id = resource_grant.authority_id
     AND authority.account_id = resource_grant.account_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.status = 'active'
      AND authority.status = 'revoked'

    UNION ALL
    -- A session-fenced grant whose epoch is AHEAD of the session it fences
    -- would survive the epoch advance that is supposed to revoke it. Epochs
    -- are monotonic and the fence is copied from the session at issuance, so
    -- `grant.authority_epoch <= session.authority_epoch` always holds.
    SELECT 'grant_session_fence_not_ahead', resource_grant.id
    FROM organization_user_resource_grants resource_grant
    JOIN sessions session_row
      ON session_row.id = resource_grant.session_id
     AND session_row.workspace_id = resource_grant.workspace_id
    WHERE resource_grant.account_id = p_organization_id
      AND resource_grant.session_id IS NOT NULL
      AND resource_grant.authority_epoch > session_row.authority_epoch

    UNION ALL
    -- Session owner provenance is paired, and a user_private session always
    -- has an owner.
    SELECT 'session_owner_provenance_paired', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND (
        (session_row.owner_organization_membership_id IS NULL)
          <> (session_row.owner_subject_id IS NULL)
        OR (session_row.visibility = 'user_private'
          AND session_row.owner_organization_membership_id IS NULL)
      )

    UNION ALL
    -- The denormalized owner subject must still name the owning membership.
    SELECT 'session_owner_subject_matches_membership', session_row.id
    FROM sessions session_row
    JOIN organization_memberships membership
      ON membership.id = session_row.owner_organization_membership_id
     AND membership.account_id = session_row.account_id
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_subject_id IS DISTINCT FROM membership.subject_id

    UNION ALL
    -- The owning membership must exist in this organization.
    SELECT 'session_owner_membership_same_organization', session_row.id
    FROM sessions session_row
    WHERE session_row.account_id = p_organization_id
      AND session_row.owner_organization_membership_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM organization_memberships membership
        WHERE membership.id = session_row.owner_organization_membership_id
          AND membership.account_id = p_organization_id
      )

    UNION ALL
    -- Provider-account collision rule: the physical unique index makes a
    -- second binding for one (provider, provider_account) impossible, so the
    -- collision is recorded by DISPUTING the existing binding and BOTH
    -- identities. A disputed binding whose identity is still usable is a
    -- collision that never fenced its identity.
    SELECT 'login_binding_dispute_propagated', binding.id
    FROM canonical_human_login_bindings binding
    JOIN scoped_identities scoped ON scoped.identity_id = binding.identity_id
    JOIN canonical_human_identities identity ON identity.id = binding.identity_id
    WHERE binding.status = 'disputed'
      AND identity.status <> 'disputed'

    UNION ALL
    -- The FK on active_login_binding_id proves existence, never ownership.
    SELECT 'identity_active_binding_owned', identity.id
    FROM canonical_human_identities identity
    JOIN scoped_identities scoped ON scoped.identity_id = identity.id
    WHERE identity.active_login_binding_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM canonical_human_login_bindings binding
        WHERE binding.id = identity.active_login_binding_id
          AND binding.identity_id = identity.id
      )

    UNION ALL
    -- Shadow comparison, connections lane: legacy effective scope is
    -- workspace; the proposed effective scope is `user`. A row claiming user
    -- authority without a live authority AND a live owning membership has no
    -- reachable user resolution - it must fall back to workspace or deny.
    SELECT 'user_scoped_resource_live_anchor', connection_row.id
    FROM connections connection_row
    WHERE connection_row.account_id = p_organization_id
      AND connection_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = connection_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', variable_set.id
    FROM workspace_variable_sets variable_set
    WHERE variable_set.account_id = p_organization_id
      AND variable_set.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = variable_set.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', rig_row.id
    FROM rigs rig_row
    WHERE rig_row.account_id = p_organization_id
      AND rig_row.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = rig_row.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    SELECT 'user_scoped_resource_live_anchor', enrollment.id
    FROM enrollments enrollment
    WHERE enrollment.account_id = p_organization_id
      AND enrollment.authority_scope = 'user'
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = enrollment.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )

    UNION ALL
    -- Documents carry the same claim as authority_kind='personal' WITH a
    -- non-null authority_id (a null authority_id there is the separate,
    -- deliberately bounded legacy lane reported under `lanes`).
    SELECT 'user_scoped_resource_live_anchor', document.id
    FROM documents document
    WHERE document.account_id = p_organization_id
      AND document.authority_kind = 'personal'
      AND document.authority_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM organization_user_resource_authorities authority
        JOIN organization_memberships membership
          ON membership.id = authority.organization_membership_id
         AND membership.account_id = authority.account_id
        WHERE authority.id = document.authority_id
          AND authority.account_id = p_organization_id
          AND authority.status = 'active'
          AND membership.status = 'active'
      )
  ),
  aggregated AS (
    SELECT
      violation.gate_id,
      count(*)::int AS violation_count,
      (pg_catalog.array_agg(
        violation.evidence_id ORDER BY violation.evidence_id
      ))[1:evidence_limit] AS evidence
    FROM violations violation
    GROUP BY violation.gate_id
  )
  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'organizationId', p_organization_id,
    'evidenceLimit', evidence_limit,
    'observationWindowDays', window_days,
    'gates', (
      SELECT pg_catalog.jsonb_object_agg(
        catalog.gate_id,
        pg_catalog.jsonb_build_object(
          'violations', coalesce(aggregated.violation_count, 0),
          'evidence', pg_catalog.to_jsonb(
            coalesce(aggregated.evidence, ARRAY[]::uuid[])
          ),
          'truncated', coalesce(aggregated.violation_count, 0)
            > coalesce(pg_catalog.array_length(aggregated.evidence, 1), 0)
        )
      )
      FROM gate_catalog catalog
      LEFT JOIN aggregated ON aggregated.gate_id = catalog.gate_id
    ),
    -- Compatibility lanes. These are populations the phase-D backfill drains;
    -- they are NOT invariant violations and must never be read as such.
    'lanes', pg_catalog.jsonb_build_object(
      'connectionsLegacyUser', (
        SELECT count(*)::int FROM connections connection_row
        WHERE connection_row.account_id = p_organization_id
          AND connection_row.authority_scope = 'legacy_user'
      ),
      -- Workspace-writer admissions and retained processes are immutable
      -- history: they are settled by UPDATE, nothing in the tree DELETEs them,
      -- and 0277's one-shot backfill only reached rows whose actor was a turn
      -- (`actor_kind`/`owner_actor_kind` = 'turn'), so every pre-0277 `direct:`
      -- or `process:` admission keeps the legacy_unattributed sentinel
      -- permanently. An all-time count of them therefore can never drain, and
      -- marking it drainable would make cutoverReady structurally unreachable
      -- for any deployment carrying one. Same treatment as the connection-use
      -- lane below: report the bounded recent window, where zero IS reachable
      -- and the honest signal is "the lane stopped being exercised".
      'workspaceWriterAdmissionsLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_workspace_mutation_admissions admission
        WHERE admission.account_id = p_organization_id
          AND admission.initiator_kind = 'legacy_unattributed'
          AND admission.admitted_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'workspaceWriterProcessesLegacyUnattributedInWindow', (
        SELECT count(*)::int FROM sandbox_retained_processes retained_process
        WHERE retained_process.account_id = p_organization_id
          AND retained_process.initiator_kind = 'legacy_unattributed'
          AND retained_process.started_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      ),
      'documentsLegacyPersonalNullAuthority', (
        SELECT count(*)::int FROM documents document
        WHERE document.account_id = p_organization_id
          AND document.authority_kind = 'personal'
          AND document.authority_id IS NULL
      ),
      'codexCredentialsUnattributedConnector', 0,
      'workspaceMemberSubjectsWithoutMembershipAnchor', (
        SELECT count(DISTINCT workspace_membership.subject_id)::int
        FROM workspace_memberships workspace_membership
        JOIN workspaces workspace ON workspace.id = workspace_membership.workspace_id
        WHERE workspace.account_id = p_organization_id
          AND workspace_membership.subject_id LIKE 'user:%%'
          AND NOT EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = workspace_membership.subject_id
          )
      ),
      -- The DRAINABLE refinement of "ownerless sessions": a session whose
      -- creating subject would be attributed by today's write fence but whose
      -- owner is still null. Total ownerlessness is deliberately NOT reported
      -- as drainable - a service/API-key session is permanently ownerless.
      'sessionsAttributableButUnattributed', (
        SELECT count(*)::int FROM sessions session_row
        WHERE session_row.account_id = p_organization_id
          AND session_row.owner_organization_membership_id IS NULL
          AND session_row.created_by_kind = 'subject'
          AND session_row.created_by_subject_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = p_organization_id
              AND membership.subject_id = session_row.created_by_subject_id
              AND membership.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM workspace_memberships workspace_membership
            WHERE workspace_membership.account_id = p_organization_id
              AND workspace_membership.workspace_id = session_row.workspace_id
              AND workspace_membership.subject_id = session_row.created_by_subject_id
          )
      ),
      -- Connection-use audit facts are immutable history, so the all-time
      -- count can never drain. The reachable-zero signal is "was the bounded
      -- pre-snapshot/legacy resolution lane exercised inside the observation
      -- window".
      'connectionUseLegacyResolutionsInWindow', (
        SELECT count(*)::int FROM connection_use_audit_facts audit_fact
        WHERE audit_fact.account_id = p_organization_id
          AND audit_fact.authority_scope = 'legacy_user'
          AND audit_fact.occurred_at
            >= pg_catalog.now() - pg_catalog.make_interval(days => window_days)
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_parity_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.activate_session_tenancy_product(p_account_id uuid, p_inventory_digest text, p_parity_digest text, p_activated_by text, p_application_roles text[])
 RETURNS TABLE(account_id uuid, activation_version integer, activated_at timestamp with time zone, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'opengeni_private', 'public', 'pg_temp'
AS $function$
DECLARE
  existing session_tenancy_activations%%ROWTYPE;
  inserted session_tenancy_activations%%ROWTYPE;
  previous_lifecycle text := pg_catalog.current_setting(
    'opengeni.organization_tenancy_lifecycle', true
  );
  inventory_report jsonb;
  parity_report jsonb;
  backfill_evidence jsonb;
  computed_inventory_digest text;
  computed_parity_digest text;
  evidence_receipt_ids uuid[];
  required_gate text;
  required_lane text;
  required_gates constant text[] := ARRAY[
    'membership_personal_workspace_pointer',
    'membership_personal_workspace_exclusive',
    'membership_personal_workspace_same_organization',
    'personal_workspace_has_no_membership_row',
    'authority_resource_single_owner',
    'grant_delegation_fence_complete',
    'grant_owner_membership_active',
    'grant_authority_live',
    'grant_session_fence_not_ahead',
    'session_owner_provenance_paired',
    'session_owner_subject_matches_membership',
    'session_owner_membership_same_organization',
    'login_binding_dispute_propagated',
    'identity_active_binding_owned',
    'user_scoped_resource_live_anchor'
  ];
  required_lanes constant text[] := ARRAY[
    'connectionsLegacyUser',
    'workspaceWriterAdmissionsLegacyUnattributedInWindow',
    'workspaceWriterProcessesLegacyUnattributedInWindow',
    'documentsLegacyPersonalNullAuthority',
    'codexCredentialsUnattributedConnector',
    'workspaceMemberSubjectsWithoutMembershipAnchor',
    'sessionsAttributableButUnattributed',
    'connectionUseLegacyResolutionsInWindow'
  ];
BEGIN
  IF p_account_id IS NULL
    OR p_inventory_digest !~ '^[0-9a-f]{64}$'
    OR p_parity_digest !~ '^[0-9a-f]{64}$'
    OR pg_catalog.octet_length(pg_catalog.btrim(p_activated_by)) NOT BETWEEN 1 AND 256
    OR p_application_roles IS NULL
    OR pg_catalog.cardinality(p_application_roles) NOT BETWEEN 1 AND 16
    OR EXISTS (
      SELECT 1 FROM pg_catalog.unnest(p_application_roles) role_name
      WHERE role_name IS NULL OR role_name <> pg_catalog.btrim(role_name)
        OR pg_catalog.octet_length(role_name) NOT BETWEEN 1 AND 63
    )
    OR pg_catalog.cardinality(ARRAY(
      SELECT DISTINCT role_name FROM pg_catalog.unnest(p_application_roles) role_name
    )) <> pg_catalog.cardinality(p_application_roles)
  THEN
    RAISE EXCEPTION 'session tenancy activation request is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));
  LOCK TABLE
    workspaces, workspace_memberships, organization_memberships,
    canonical_human_identities, canonical_human_identity_subjects,
    canonical_human_login_bindings, sessions, session_turns,
    session_turn_attempts, session_attempt_interruptions,
    session_system_updates, session_human_input_requests,
    session_pending_tool_calls, agent_run_states, session_goals,
    session_realtime_modes,
    session_realtime_connections, scheduled_tasks,
    workspace_variable_sets, rigs, enrollments, connections, documents,
    sandbox_workspace_mutation_admissions,
    sandbox_retained_processes, sandbox_lease_holders,
    organization_user_resource_authorities, organization_user_resource_grants,
    connection_use_audit_facts, tenancy_backfill_receipts,
    tenancy_backfill_unresolved_rows, session_tenancy_activations
  IN ACCESS EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_stat_activity activity
    WHERE activity.datname = pg_catalog.current_database()
      AND activity.usename = ANY(p_application_roles)
      AND activity.pid <> pg_catalog.pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'session tenancy activation requires every application role session to be stopped'
      USING ERRCODE = '55000';
  END IF;

  -- Lock every provisioning source before the shared deployment fence. The
  -- greenfield path writes its graph first and takes the fence last; reversing
  -- this order would deadlock RowExclusive -> boundary against boundary ->
  -- AccessExclusive during the first cutover.
  PERFORM lock_session_tenancy_activation_boundary();
  PERFORM pg_catalog.set_config('opengeni.account_id', p_account_id::text, true);
  SELECT * INTO existing FROM session_tenancy_activations activation
  WHERE activation.account_id = p_account_id;
  IF FOUND THEN
    IF existing.inventory_digest <> p_inventory_digest
      OR existing.parity_digest <> p_parity_digest
    THEN
      RAISE EXCEPTION 'session tenancy activation evidence conflicts with the durable receipt'
        USING ERRCODE = '23505';
    END IF;
    account_id := existing.account_id;
    activation_version := existing.activation_version;
    activated_at := existing.activated_at;
    replay := true;
    RETURN NEXT;
    RETURN;
  END IF;

  inventory_report := inventory_organization_tenancy(p_account_id);
  parity_report := check_organization_tenancy_parity(p_account_id, 10, 30);
  backfill_evidence := check_tenancy_backfill_activation_evidence(p_account_id);
  IF inventory_report #>> '{schemaVersion}' <> '2'
    OR inventory_report ->> 'organizationId' <> p_account_id::text
    OR parity_report #>> '{schemaVersion}' <> '1'
    OR parity_report ->> 'organizationId' <> p_account_id::text
    OR pg_catalog.jsonb_typeof(parity_report -> 'gates') <> 'object'
    OR pg_catalog.jsonb_typeof(parity_report -> 'lanes') <> 'object'
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;

  FOREACH required_gate IN ARRAY required_gates LOOP
    IF NOT (parity_report -> 'gates' ? required_gate)
      OR pg_catalog.jsonb_typeof(parity_report -> 'gates' -> required_gate -> 'violations')
        <> 'number'
      OR (parity_report #>> ARRAY['gates', required_gate, 'violations'])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation parity gate is not clean: %%', required_gate
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'gates') gate
    WHERE pg_catalog.jsonb_typeof(gate.value -> 'violations') <> 'number'
      OR (gate.value ->> 'violations')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation parity has a non-zero gate'
      USING ERRCODE = '55000';
  END IF;
  FOREACH required_lane IN ARRAY required_lanes LOOP
    IF NOT (parity_report -> 'lanes' ? required_lane)
      OR pg_catalog.jsonb_typeof(parity_report -> 'lanes' -> required_lane) <> 'number'
      OR (parity_report #>> ARRAY['lanes', required_lane])::bigint <> 0
    THEN
      RAISE EXCEPTION 'session tenancy activation compatibility lane is not drained: %%',
        required_lane USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_each(parity_report -> 'lanes') lane
    WHERE pg_catalog.jsonb_typeof(lane.value) <> 'number'
      OR (lane.value #>> '{}')::bigint <> 0
  ) THEN
    RAISE EXCEPTION 'session tenancy activation has an undrained compatibility lane'
      USING ERRCODE = '55000';
  END IF;
  IF coalesce((backfill_evidence ->> 'ready')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'session tenancy activation requires settled backfill evidence'
      USING ERRCODE = '55000', DETAIL = (backfill_evidence -> 'blockers')::text;
  END IF;

  computed_inventory_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(inventory_report), 'UTF8'
  ), 'sha256'), 'hex');
  computed_parity_digest := pg_catalog.encode(%1$I.digest(pg_catalog.convert_to(
    opengeni_private.tenancy_activation_canonical_json(parity_report), 'UTF8'
  ), 'sha256'), 'hex');
  IF computed_inventory_digest <> p_inventory_digest
    OR computed_parity_digest <> p_parity_digest
  THEN
    RAISE EXCEPTION 'session tenancy activation evidence changed before the cutover lock'
      USING ERRCODE = '40001';
  END IF;

  SELECT pg_catalog.array_agg(receipt_id::uuid ORDER BY ordinal)
    INTO evidence_receipt_ids
  FROM pg_catalog.jsonb_array_elements_text(backfill_evidence -> 'receiptIds')
    WITH ORDINALITY AS evidence(receipt_id, ordinal);
  IF pg_catalog.cardinality(evidence_receipt_ids) <> 6 THEN
    RAISE EXCEPTION 'session tenancy activation backfill evidence is structurally invalid'
      USING ERRCODE = '55000';
  END IF;
  -- The narrow marker window for the one append this function performs. The
  -- `RETURNING` read is covered by 0303's existing organization-isolation
  -- SELECT policy, whose account GUC this function already set above.
  BEGIN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', 'session_tenancy_activation', true
    );
    INSERT INTO session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest,
      activated_by, backfill_receipt_ids
    ) VALUES (
      p_account_id, 1, p_inventory_digest, p_parity_digest,
      pg_catalog.btrim(p_activated_by), evidence_receipt_ids
    ) RETURNING * INTO inserted;
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_catalog.set_config(
      'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true
    );
    RAISE;
  END;
  account_id := inserted.account_id;
  activation_version := inserted.activation_version;
  activated_at := inserted.activated_at;
  replay := false;
  RETURN NEXT;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.finalize_organization_retention_deletion(p_account_id uuid, p_membership_id uuid, p_operation_id uuid, p_object_bucket text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'opengeni_private', 'pg_temp'
AS $function$
DECLARE
  member organization_memberships%%ROWTYPE;
  deletion organization_user_retention_deletions%%ROWTYPE;
  prior_event organization_user_retention_deletion_events%%ROWTYPE;
  unsupported_kind text;
  candidate_file_ids uuid[];
  deleted_documents integer := 0;
  deleted_files integer := 0;
  deleted_variable_sets integer := 0;
  deleted_rigs integer := 0;
  deleted_connections integer := 0;
  deleted_codex integer := 0;
  deleted_xai integer := 0;
  deleted_claude integer := 0;
  deleted_subscriptions integer := 0;
  tombstoned_machines integer := 0;
  deleted_workspace integer := 0;
  object_count integer := 0;
  locked_personal_workspace_id uuid;
  result_value jsonb;
BEGIN
  IF nullif(p_object_bucket, '') IS NULL
    OR octet_length(convert_to(p_object_bucket, 'UTF8')) > 1024
  THEN
    RAISE EXCEPTION 'invalid retention object bucket' USING ERRCODE = '22023';
  END IF;
  PERFORM opengeni_private.assert_organization_retention_account(p_account_id);
  PERFORM acquire_organization_session_tenancy_fences(
    p_account_id
  );
  PERFORM pg_catalog.set_config(
    'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('organization-retention:' || p_operation_id::text, 0)
  );
  SELECT * INTO prior_event FROM organization_user_retention_deletion_events event
  WHERE event.account_id = p_account_id AND event.operation_id = p_operation_id
    AND event.kind = 'completed';
  IF FOUND THEN
    IF prior_event.membership_id IS DISTINCT FROM p_membership_id THEN
      RAISE EXCEPTION 'retention completion operation id belongs to another membership'
        USING ERRCODE = '23505';
    END IF;
    SELECT candidate.database_result INTO result_value
    FROM organization_user_retention_deletions candidate
    WHERE candidate.account_id = p_account_id
      AND candidate.membership_id = p_membership_id;
    IF NOT FOUND
      OR result_value ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
    THEN
      RAISE EXCEPTION 'retention completion operation id has different frozen input'
        USING ERRCODE = '23505';
    END IF;
    RETURN result_value;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
  THEN RAISE EXCEPTION 'retention membership is not eligible' USING ERRCODE = '42501'; END IF;
  locked_personal_workspace_id := member.personal_workspace_id;
  IF locked_personal_workspace_id IS NOT NULL THEN
    PERFORM 1 FROM workspaces workspace
    WHERE workspace.account_id = p_account_id
      AND workspace.id = locked_personal_workspace_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'retention personal workspace is missing' USING ERRCODE = '40001';
    END IF;
  END IF;
  SELECT * INTO member FROM organization_memberships membership
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR member.status <> 'revoked'
    OR member.personal_retention_until IS NULL
    OR member.personal_retention_until > clock_timestamp()
    OR member.personal_workspace_id IS DISTINCT FROM locked_personal_workspace_id
  THEN RAISE EXCEPTION 'retention membership changed during finalization'
    USING ERRCODE = '40001'; END IF;
  SELECT * INTO deletion FROM organization_user_retention_deletions candidate
  WHERE candidate.account_id = p_account_id AND candidate.membership_id = p_membership_id
  FOR UPDATE;
  IF NOT FOUND OR deletion.state <> 'claimed'
    OR deletion.claim_operation_id <> p_operation_id
    OR deletion.claim_expires_at <= clock_timestamp()
  THEN RAISE EXCEPTION 'retention deletion claim is stale' USING ERRCODE = '40001'; END IF;
  IF deletion.retention_until IS DISTINCT FROM member.personal_retention_until THEN
    RAISE EXCEPTION 'retention deadline changed after claim' USING ERRCODE = '40001';
  END IF;
  IF deletion.database_finalized_at IS NOT NULL THEN
    IF deletion.database_result ->> 'objectBucket' IS DISTINCT FROM p_object_bucket
      OR EXISTS (
        SELECT 1 FROM organization_user_retention_object_obligations obligation
        WHERE obligation.account_id = p_account_id
          AND obligation.membership_id = p_membership_id
          AND obligation.object_bucket <> p_object_bucket
      )
    THEN
      RAISE EXCEPTION 'retention object bucket changed after database finalization'
        USING ERRCODE = '40001';
    END IF;
    RETURN pg_catalog.jsonb_set(
      deletion.database_result,
      '{operationId}',
      pg_catalog.to_jsonb(p_operation_id::text),
      false
    );
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM documents document
    LEFT JOIN organization_user_resource_authorities authority
      ON authority.id = document.authority_id
     AND authority.account_id = document.account_id
     AND authority.organization_membership_id = document.owner_organization_membership_id
     AND authority.resource_kind = 'document'
     AND authority.resource_id = document.id
    WHERE document.account_id = p_account_id
      AND document.workspace_id = member.personal_workspace_id
      AND (
        authority.id IS NULL
        OR authority.organization_membership_id <> p_membership_id
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains retained external document authority'
      USING ERRCODE = '55000';
  END IF;
  IF member.personal_workspace_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM workspace_captures capture
    WHERE capture.account_id = p_account_id
      AND capture.workspace_id = member.personal_workspace_id
      AND (
        pg_catalog.jsonb_typeof(capture.blob_keys) <> 'array'
        OR CASE WHEN pg_catalog.jsonb_typeof(capture.blob_keys) = 'array' THEN EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(capture.blob_keys) blob(value)
            WHERE pg_catalog.jsonb_typeof(blob.value) <> 'string'
              OR octet_length(convert_to(blob.value #>> '{}', 'UTF8')) NOT BETWEEN 1 AND 4096
          ) ELSE false END
      )
  ) THEN
    RAISE EXCEPTION 'personal workspace contains malformed external object inventory'
      USING ERRCODE = '55000';
  END IF;
  SELECT authority.resource_kind INTO unsupported_kind
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind NOT IN (
      'claude_subscription', 'codex_subscription', 'connected_machine', 'connection', 'document',
      'rig', 'subscription_connection', 'variable_set', 'xai_subscription'
    )
  ORDER BY authority.resource_kind LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unsupported retained resource kind: %%', unsupported_kind
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
  ORDER BY authority.id FOR UPDATE;
  SELECT COALESCE(array_agg(candidate.file_id ORDER BY candidate.file_id), ARRAY[]::uuid[])
  INTO candidate_file_ids
  FROM opengeni_private.organization_retention_file_candidates(
    p_account_id, p_membership_id
  ) candidate;
  PERFORM 1 FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
  ORDER BY file.id FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM opengeni_private.organization_retention_file_candidates(
      p_account_id, p_membership_id
    ) candidate
    WHERE candidate.object_bucket IS DISTINCT FROM p_object_bucket
  ) THEN
    RAISE EXCEPTION 'retention file bucket differs from configured object storage'
      USING ERRCODE = '55000';
  END IF;
  -- Freeze every external-key source before materializing obligations. The
  -- workspace row above excludes new FK children; these row locks exclude key
  -- rotation while exact obligations are copied and the workspace is erased.
  PERFORM 1 FROM session_recordings recording
  WHERE recording.account_id = p_account_id
    AND recording.workspace_id = member.personal_workspace_id
  ORDER BY recording.id FOR UPDATE;
  PERFORM 1 FROM browser_state_artifacts artifact
  WHERE artifact.account_id = p_account_id
    AND artifact.workspace_id = member.personal_workspace_id
  ORDER BY artifact.id FOR UPDATE;
  PERFORM 1 FROM browser_state_uploads upload
  WHERE upload.account_id = p_account_id
    AND upload.workspace_id = member.personal_workspace_id
  ORDER BY upload.id FOR UPDATE;
  PERFORM 1 FROM transcription_recording_objects recording_object
  WHERE recording_object.account_id = p_account_id
    AND recording_object.workspace_id = member.personal_workspace_id
  ORDER BY recording_object.object_key FOR UPDATE;
  PERFORM 1 FROM video_generation_references reference
  WHERE reference.account_id = p_account_id
    AND reference.workspace_id = member.personal_workspace_id
  ORDER BY reference.operation_id, reference.ordinal FOR UPDATE;
  PERFORM 1 FROM workspace_artifact_versions version
  WHERE version.account_id = p_account_id
    AND version.workspace_id = member.personal_workspace_id
  ORDER BY version.id FOR UPDATE;
  PERFORM 1 FROM editable_artifact_blob_refs blob
  WHERE blob.account_id = p_account_id
    AND blob.workspace_id = member.personal_workspace_id
  ORDER BY blob.artifact_id, blob.id FOR UPDATE;
  PERFORM 1 FROM workspace_captures capture
  WHERE capture.account_id = p_account_id
    AND capture.workspace_id = member.personal_workspace_id
  ORDER BY capture.id FOR UPDATE;
  INSERT INTO organization_user_retention_object_obligations (
    account_id, membership_id, object_kind, source_id, object_bucket, object_key,
    prepared_operation_id, object_key_hash
  )
  SELECT p_account_id, p_membership_id, candidate.object_kind,
    candidate.source_id, p_object_bucket, candidate.object_key, p_operation_id,
    encode(digest(candidate.object_key, 'sha256'), 'hex')
  FROM opengeni_private.organization_retention_object_candidates(
    p_account_id, p_membership_id
  ) candidate;
  GET DIAGNOSTICS object_count = ROW_COUNT;

  DELETE FROM documents document
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'document'
    AND authority.resource_id = document.id
    AND document.account_id = authority.account_id
    AND document.authority_id = authority.id
    AND document.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_documents = ROW_COUNT;
  DELETE FROM files file
  WHERE file.account_id = p_account_id AND file.id = ANY(candidate_file_ids)
    AND NOT EXISTS (SELECT 1 FROM documents document WHERE document.file_id = file.id);
  GET DIAGNOSTICS deleted_files = ROW_COUNT;

  UPDATE scheduled_tasks task SET status = 'paused', variable_set_id = NULL,
    authority_revision = authority_revision + 1, updated_at = clock_timestamp()
  WHERE task.account_id = p_account_id AND task.variable_set_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'variable_set'
  );
  PERFORM opengeni_private.detach_retention_variable_set_session_selections(
    p_account_id, p_membership_id, p_operation_id
  );
  DELETE FROM workspace_variable_sets resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'variable_set'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_variable_sets = ROW_COUNT;

  UPDATE capability_facet_installations binding SET connection_id = NULL,
    status = 'needs_attention',
    attention_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  UPDATE integration_facet_bindings binding SET connection_id = NULL,
    status = 'needs_attention',
    last_error_code = 'owner_retention_deleted',
    version = version + 1, updated_at = clock_timestamp()
  WHERE binding.account_id = p_account_id AND binding.connection_id IN (
    SELECT authority.resource_id FROM organization_user_resource_authorities authority
    WHERE authority.account_id = p_account_id
      AND authority.organization_membership_id = p_membership_id
      AND authority.resource_kind = 'connection'
  );
  DELETE FROM connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_connections = ROW_COUNT;

  DELETE FROM subscription_connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'subscription_connection'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_subscriptions = ROW_COUNT;

  DELETE FROM rigs resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'rig'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_rigs = ROW_COUNT;

  UPDATE enrollments resource SET status = 'revoked',
    revoked_at = COALESCE(resource.revoked_at, clock_timestamp()),
    generation = resource.generation + 1, connection_instance_id = NULL,
    connection_lease_expires_at = NULL, desktop_unavailable_reason = NULL,
    updated_at = clock_timestamp()
  FROM organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = 'connected_machine'
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS tombstoned_machines = ROW_COUNT;

  UPDATE organization_user_resource_authorities authority
  SET status = 'revoked', revoked_at = COALESCE(authority.revoked_at, clock_timestamp()),
    generation = authority.generation + 1, updated_at = clock_timestamp()
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.status <> 'revoked';
  UPDATE organization_memberships membership
  SET personal_workspace_id = NULL, updated_at = clock_timestamp()
  WHERE membership.account_id = p_account_id AND membership.id = p_membership_id;
  IF member.personal_workspace_id IS NOT NULL THEN
    DELETE FROM workspaces workspace
    WHERE workspace.account_id = p_account_id AND workspace.id = member.personal_workspace_id;
    GET DIAGNOSTICS deleted_workspace = ROW_COUNT;
  END IF;
  result_value := pg_catalog.jsonb_build_object(
    'organizationId', p_account_id,
    'membershipId', p_membership_id,
    'operationId', p_operation_id,
    'outcome', 'cleanup_pending',
    'objectBucket', p_object_bucket,
    'objectCount', object_count,
    'deletedResources', pg_catalog.jsonb_build_object(
      'documents', deleted_documents, 'files', deleted_files,
      'variableSets', deleted_variable_sets, 'rigs', deleted_rigs,
      'connections', deleted_connections, 'codexSubscriptions', deleted_codex,
      'xaiSubscriptions', deleted_xai, 'claudeSubscriptions', deleted_claude,
      'subscriptionConnections', deleted_subscriptions, 'connectedMachinesTombstoned', tombstoned_machines,
      'personalWorkspaces', deleted_workspace
    ),
    'databaseFinalizedAt', clock_timestamp()
  );
  UPDATE organization_user_retention_deletions current_deletion
  SET database_result = result_value, database_finalized_at = clock_timestamp(),
    claim_expires_at = clock_timestamp() + interval '15 minutes',
    updated_at = clock_timestamp()
  WHERE current_deletion.account_id = p_account_id
    AND current_deletion.membership_id = p_membership_id
    AND current_deletion.claim_operation_id = p_operation_id;
  RETURN result_value;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.inventory_organization_tenancy(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO '$user', %1$L
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'tenancy inventory requires an organization id'
      USING ERRCODE = '22004';
  END IF;
  IF p_organization_id IS DISTINCT FROM nullif(
      pg_catalog.current_setting('opengeni.account_id', true), ''
    )::uuid
  THEN
    RAISE EXCEPTION 'tenancy inventory scope mismatch'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO opengeni_private.organization_tenancy_inventory_capabilities (
    backend_pid, transaction_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id())
  ON CONFLICT DO NOTHING;

  SELECT pg_catalog.jsonb_build_object(
    'schemaVersion', 2,
    'organizationId', p_organization_id,
    'workspaces', (
      SELECT count(*)::int FROM workspaces w WHERE w.account_id = p_organization_id
    ),
    'organizationMemberships', (
      SELECT pg_catalog.jsonb_build_object(
        'byStatus', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(m.status, m.n)
           FROM (
             SELECT om.status, count(*)::int AS n
             FROM organization_memberships om
             WHERE om.account_id = p_organization_id
             GROUP BY om.status
           ) m),
          '{}'::jsonb
        ),
        'activeWithoutPersonalWorkspace', (
          SELECT count(*)::int FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.status = 'active'
            AND om.personal_workspace_id IS NULL
        )
      )
    ),
    -- Humans with persisted workspace access in this organization but no
    -- organization-membership anchor: nothing exists yet for a backfill to
    -- attach canonical ownership to (they never re-authenticated post-0219).
    'workspaceMemberSubjectsWithoutMembershipAnchor', (
      SELECT count(DISTINCT wm.subject_id)::int
      FROM workspace_memberships wm
      JOIN workspaces w ON w.id = wm.workspace_id
      WHERE w.account_id = p_organization_id
        AND wm.subject_id LIKE 'user:%%'
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships om
          WHERE om.account_id = p_organization_id
            AND om.subject_id = wm.subject_id
        )
    ),
    'sessions', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        'ownerless', count(*) FILTER (
          WHERE s.owner_organization_membership_id IS NULL
        )::int,
        'userPrivate', count(*) FILTER (
          WHERE s.visibility = 'user_private'
        )::int,
        'advancedAuthorityEpoch', count(*) FILTER (
          WHERE s.authority_epoch > 1
        )::int
      )
      FROM sessions s WHERE s.account_id = p_organization_id
    ),
    -- Variable Sets, Rigs, and Connected Machines report ONLY the authority
    -- lane breakdown. An `unclassified` counter is deliberately absent: the
    -- shape checks REQUIRE a NULL authority_id for organization/workspace
    -- rows, `authority_scope` DEFAULTS to 'workspace', and no column records
    -- that a classification decision was ever made - see this migration's
    -- header for the per-family analysis.
    'variableSets', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(v.authority_scope, v.n)
           FROM (
             SELECT vs.authority_scope, count(*)::int AS n
             FROM workspace_variable_sets vs
             WHERE vs.account_id = p_organization_id
             GROUP BY vs.authority_scope
           ) v),
          '{}'::jsonb
        )
      )
    ),
    'rigs', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(r.authority_scope, r.n)
           FROM (
             SELECT rr.authority_scope, count(*)::int AS n
             FROM rigs rr WHERE rr.account_id = p_organization_id
             GROUP BY rr.authority_scope
           ) r),
          '{}'::jsonb
        )
      )
    ),
    'machines', (
      SELECT pg_catalog.jsonb_build_object(
        'byScope', coalesce(
          (SELECT pg_catalog.jsonb_object_agg(e.authority_scope, e.n)
           FROM (
             SELECT en.authority_scope, count(*)::int AS n
             FROM enrollments en WHERE en.account_id = p_organization_id
             GROUP BY en.authority_scope
           ) e),
          '{}'::jsonb
        )
      )
    ),
    'connections', (
      SELECT coalesce(
        (SELECT pg_catalog.jsonb_object_agg(c.authority_scope, c.n)
         FROM (
           SELECT cn.authority_scope, count(*)::int AS n
           FROM connections cn WHERE cn.account_id = p_organization_id
           GROUP BY cn.authority_scope
         ) c),
        '{}'::jsonb
      )
    ),
    -- Linked-input gate (documents-internal migration is owned elsewhere and
    -- never written by this program; the count is the cutover gate input).
    'documents', (
      SELECT pg_catalog.jsonb_build_object(
        'total', count(*)::int,
        -- The gate population is a LEGACY personal Document with no common
        -- authority - organization/workspace documents are REQUIRED to have
        -- a NULL authority_id forever (documents_authority_chk, 0258) and
        -- must never be counted as unmigrated.
        'legacyPersonalNullAuthority', count(*) FILTER (
          WHERE d.authority_kind = 'personal' AND d.authority_id IS NULL
        )::int
      )
      FROM documents d WHERE d.account_id = p_organization_id
    ),
    -- The legacy credential population is gone; retain the report's shape.
    'codexCredentials', pg_catalog.jsonb_build_object('total', 0, 'unattributedConnector', 0),
    'workspaceWriters', (
      SELECT pg_catalog.jsonb_build_object(
        'admissions', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE a.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_workspace_mutation_admissions a
          WHERE a.account_id = p_organization_id
        ),
        'retainedProcesses', (
          SELECT pg_catalog.jsonb_build_object(
            'total', count(*)::int,
            'legacyUnattributed', count(*) FILTER (
              WHERE p.initiator_kind = 'legacy_unattributed'
            )::int
          )
          FROM sandbox_retained_processes p
          WHERE p.account_id = p_organization_id
        )
      )
    )
  ) INTO result;

  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RETURN result;
EXCEPTION WHEN OTHERS THEN
  DELETE FROM opengeni_private.organization_tenancy_inventory_capabilities
  WHERE backend_pid = pg_catalog.pg_backend_pid()
    AND transaction_id = pg_catalog.pg_current_xact_id_if_assigned();
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer)
 RETURNS TABLE(operation_id uuid, event_id uuid, event_sequence integer, session_id uuid, workspace_id uuid, visibility text, authority_epoch integer, copied_history_item_count integer, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
DECLARE
  actor_membership organization_memberships%%ROWTYPE;
  source_session sessions%%ROWTYPE;
  destination_row sessions%%ROWTYPE;
  fork_same_creator boolean;
  destination_workspace workspaces%%ROWTYPE;
  receipt_row session_command_receipts%%ROWTYPE;
  destination_session_id uuid;
  history_count integer := 0;
  destination_activity_revision bigint;
  destination_depth integer;
  destination_depth_source text;
  destination_resources jsonb := '[]'::jsonb;
  event_row_id uuid;
  public_destination_visibility text;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_gate_state text := current_setting('opengeni.session_activity_gate_state', true);
  previous_gate_workspace text := current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
BEGIN
  IF p_account_id IS NULL OR p_source_workspace_id IS NULL
    OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
    OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
    OR p_workspace_shared_acknowledged IS NULL
    OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
    OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session fork requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session fork authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_destination_workspace_id IS DISTINCT FROM p_source_workspace_id
    OR p_destination_visibility NOT IN ('user_private', 'workspace_shared')
    OR (p_destination_visibility = 'user_private' AND p_workspace_shared_acknowledged)
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session fork request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF nullif(previous_gate_state, '') IS NOT NULL
    OR nullif(previous_gate_workspace, '') IS NOT NULL
  THEN RAISE EXCEPTION 'session fork requires ownership of the activity gate'
    USING ERRCODE = '55000'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_source_workspace_id::text, 0
  ));

  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  SELECT * INTO destination_workspace FROM workspaces workspace_row
  WHERE workspace_row.account_id = p_account_id
    AND workspace_row.id = p_source_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_source_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_source_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session fork requires active workspace authority'
    USING ERRCODE = '42501'; END IF;

  -- Resolve an already-applied receipt before inspecting mutable source state.
  -- The same still-authorized workspace actor can therefore recover the exact
  -- destination after a lost response even if the source owner later makes the
  -- source private. A new key still reaches the current source authorization
  -- check below and is denied.
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
    AND receipt.result ->> 'status' = 'applied';
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- Product decision, distinct from authority, and the same one migration 0323
  -- makes on the create path: a private destination inside a shared workspace
  -- requires the organization's private-session setting. A personal workspace
  -- is exempt exactly as it is there. This is deliberately placed after the
  -- keyed replay above and before any source read, so a fork that already
  -- committed still replays byte-identically after an owner disables the
  -- setting, while a fresh key fails closed with the same SQLSTATE the create
  -- path raises.
  IF p_destination_visibility = 'user_private'
    AND actor_membership.personal_workspace_id IS DISTINCT FROM p_source_workspace_id
    AND NOT organization_private_sessions_enabled(p_account_id)
  THEN
    RAISE EXCEPTION
      'private sessions are not enabled for this organization''s shared workspaces'
      USING ERRCODE = '55000';
  END IF;

  SELECT session.* INTO source_session FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_source_workspace_id
    AND session.id = p_source_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork source session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  -- A private source remains owner-only. A workspace-shared source follows
  -- current workspace authority, and the fork becomes a fresh session owned
  -- by the actor. This is what lets any authorized collaborator fork shared
  -- work privately without retaining the source owner's authority.
  IF source_session.visibility = 'user_private' AND (
    source_session.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR source_session.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  )
  THEN RAISE EXCEPTION 'session fork source session is private'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
    'session.fork', p_source_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- The acknowledgement is content-exposure evidence, not a blanket checkbox:
  -- it is required only when private source content crosses into workspace scope.
  IF source_session.visibility = 'user_private'
    AND p_destination_visibility = 'workspace_shared'
    AND NOT p_workspace_shared_acknowledged
  THEN RAISE EXCEPTION 'private-to-workspace fork requires explicit acknowledgement'
    USING ERRCODE = '22023'; END IF;

  PERFORM assert_session_tenancy_quiescent(
    p_account_id, p_source_workspace_id, p_source_session_id, false
  );

  SELECT coalesce(jsonb_agg(
    CASE WHEN resource.value ->> 'connectionType' = 'github_personal'
      THEN resource.value
        - 'provider' - 'connectionType' - 'credentialBindingId' - 'access'
        - 'repositoryId' - 'installationId' - 'projectId' - 'connectionId'
        - 'githubInstallationId' - 'githubRepositoryId'
      ELSE resource.value
        - 'credentialBindingId' - 'connectionId' - 'installationId'
        - 'projectId' - 'githubInstallationId'
    END
    ORDER BY resource.ordinality
  ), '[]'::jsonb) INTO destination_resources
  FROM jsonb_array_elements(source_session.resources)
    WITH ORDINALITY AS resource(value, ordinality);

  DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;
  CREATE TEMP TABLE opengeni_session_fork_history_spool (
    position numeric NOT NULL,
    item jsonb NOT NULL, item_ordered json NOT NULL,
    item_codec_version integer,
    active boolean NOT NULL,
    provider_artifact_invalidated_at timestamptz,
    provider_artifact_invalidation_reason text,
    provider_artifact_invalidated_by_attempt_id uuid,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.opengeni_session_fork_history_spool (
    position, item, item_ordered, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT source_item.position, source_item.item, source_item.item_ordered,
      source_item.item_codec_version, source_item.active,
      source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id,
      source_item.created_at
    FROM session_history_items source_item
    WHERE source_item.account_id = p_account_id
      AND source_item.workspace_id = p_source_workspace_id
      AND source_item.session_id = p_source_session_id
    ORDER BY source_item.position;
  GET DIAGNOSTICS history_count = ROW_COUNT;

  SELECT coalesce(
      CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
        THEN (destination_workspace.settings ->> 'maxNestedAgentDepth')::integer END,
      configuration.max_nested_agent_depth
    ),
    CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
      THEN 'workspace' ELSE configuration.policy_source END
  INTO destination_depth, destination_depth_source
  FROM nested_agent_depth_configuration configuration
  WHERE configuration.singleton = true;
  IF destination_depth IS NULL OR destination_depth_source IS NULL THEN
    RAISE EXCEPTION 'session fork destination depth policy is unavailable'
      USING ERRCODE = '55000';
  END IF;

  destination_session_id := gen_random_uuid();
  public_destination_visibility := CASE p_destination_visibility
    WHEN 'user_private' THEN 'private' ELSE 'workspace' END;
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    visibility_write_capability_id::text, true);
  PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    p_source_workspace_id::text, true);

  -- A fork is the same agent as its source. Start from the complete source row
  -- so every agent setting, including columns added later, carries over. Then
  -- replace only what belongs to the new session or to the person who created
  -- the source. session-fork-agent-parity-postgres.test.ts classifies every
  -- column; a new column must be placed on one side or the other.
  destination_row := source_session;
  -- Settings bound to the source's creator personally carry over only when
  -- that same person forks a top-level session they created.
  fork_same_creator := source_session.parent_session_id IS NULL
    AND source_session.created_by_kind = 'subject'
    AND source_session.created_by_subject_id = p_actor_subject_id;

  -- Identity, ownership and provenance of the new session.
  destination_row.id := destination_session_id;
  destination_row.account_id := p_account_id;
  destination_row.workspace_id := p_source_workspace_id;
  destination_row.created_at := now();
  destination_row.updated_at := now();
  destination_row.authority_inserted_at := transaction_timestamp();
  destination_row.created_by_kind := 'subject';
  destination_row.created_by_subject_id := p_actor_subject_id;
  destination_row.created_by_context := jsonb_build_object(
      'fork', true,
      'sourceSessionId', p_source_session_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged
    );
  destination_row.owner_organization_membership_id := actor_membership.id;
  destination_row.owner_subject_id := actor_membership.subject_id;
  -- Both visibility columns record the audience the fork's creator asked for;
  -- the source's creation request is its own history.
  destination_row.visibility := p_destination_visibility;
  destination_row.create_requested_visibility := p_destination_visibility;
  destination_row.authority_epoch := 1;
  destination_row.execution_authority_epoch := 1;
  destination_row.forked_from_session_id := p_source_session_id;
  destination_row.forked_from_authority_epoch := source_session.authority_epoch;
  destination_row.forked_from_visibility := source_session.visibility;
  destination_row.forked_at := clock_timestamp();
  destination_row.forked_by_organization_membership_id := actor_membership.id;
  destination_row.create_idempotency_key := NULL;
  destination_row.agent_creation_attempt_id := NULL;
  destination_row.imported_archive_import_id := NULL;
  destination_row.imported_archive_imported_at := NULL;
  destination_row.imported_archive_request_hash := NULL;
  destination_row.imported_archive_subject_id := NULL;
  destination_row.imported_archive_next_offset := NULL;
  -- Historical end-user labels; new sessions never write them.
  destination_row.end_user_source := NULL;
  destination_row.end_user_id := NULL;
  -- A Site audience is derived by the server for a Site conversation itself.
  destination_row.site_id := NULL;
  destination_row.site_access_root_id := NULL;
  destination_row.site_viewer_principal := NULL;
  destination_row.site_owner_subject_id := NULL;
  -- Metadata keeps the agent's settings (model, reasoning, execution policy,
  -- creation configuration). Links to a schedule run, a Site, or this
  -- session's own fork runtime receipt identify the source, not the agent.
  destination_row.metadata := source_session.metadata
    - 'scheduledTaskId' - 'scheduledTaskRunId' - 'opengeniPublishedSite'
    - '_opengeniSiteOrigin' - 'forkRuntimeConfiguration';

  -- A fork is the root of its own tree and keeps the nesting limit the source
  -- chose for itself; otherwise the destination workspace policy applies.
  destination_row.parent_session_id := NULL;
  destination_row.parent_turn_id := NULL;
  destination_row.root_session_id := destination_session_id;
  destination_row.nested_agent_depth := 0;
  destination_row.max_nested_agent_depth_override := CASE
    WHEN source_session.nested_agent_depth_policy_source = 'session'
    THEN source_session.effective_max_nested_agent_depth END;
  destination_row.effective_max_nested_agent_depth :=
    coalesce(destination_row.max_nested_agent_depth_override, destination_depth);
  destination_row.nested_agent_depth_policy_source := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN destination_depth_source ELSE 'session' END;
  destination_row.nested_agent_depth_policy_session_id := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN NULL ELSE destination_session_id END;

  -- A new session starts idle in its own sandbox group, with no runs, queue,
  -- controls, waits, archive or measurements of its own yet.
  destination_row.status := 'idle';
  destination_row.temporal_workflow_id := 'session-' || destination_session_id::text;
  destination_row.active_turn_id := NULL;
  destination_row.execution_context_turn_id := NULL;
  destination_row.last_sequence := 1;
  destination_row.queue_version := 0;
  destination_row.queue_head_position := 0;
  destination_row.queue_tail_position := 0;
  destination_row.sandbox_group_id := destination_session_id;
  destination_row.active_sandbox_id := NULL;
  destination_row.active_epoch := 0;
  destination_row.working_dir := NULL;
  destination_row.last_input_tokens := NULL;
  destination_row.compact_requested := false;
  destination_row.direct_control_state := 'active';
  destination_row.direct_pause_revision := NULL;
  destination_row.subtree_run_override_revision := NULL;
  destination_row.control_version := 0;
  destination_row.direct_control_reason := NULL;
  destination_row.direct_control_changed_by := NULL;
  destination_row.direct_control_changed_at := NULL;
  destination_row.activity_revision := 0;
  destination_row.activity_revision_pending_xid := NULL;
  destination_row.activity_xid := '0'::xid8;
  destination_row.input_wait_turn_id := NULL;
  destination_row.input_wait_until := NULL;
  destination_row.input_wait_reason := NULL;
  destination_row.input_wait_set_at := NULL;
  destination_row.admission_block := NULL;
  destination_row.content_archive_state := NULL;
  destination_row.content_archive_started_at := NULL;
  destination_row.content_archived_at := NULL;
  destination_row.content_archive := NULL;
  destination_row.content_archive_purged_at := NULL;
  -- Optimistic edit counter of this row's tool policy, not the policy itself.
  destination_row.tool_policy_version := 1;
  destination_row.resources := destination_resources;
  -- Variable Sets are retired; only an explicit fork runtime request may
  -- select runtime setup, and that path now refuses Variable Sets.
  destination_row.variable_set_ids := '[]'::jsonb;
  destination_row.variable_set_id := NULL;
  -- Another person's personal Rig stays with them.
  IF source_session.rig_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM rigs rig_row
    WHERE rig_row.account_id = p_account_id AND rig_row.id = source_session.rig_id
      AND rig_row.authority_scope = 'user'
      AND rig_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
  ) THEN
    destination_row.rig_id := NULL;
    destination_row.rig_version_id := NULL;
  END IF;

  -- What the source's creator accepted for the source's first turn stays with
  -- that turn. A fork starts no first turn and accepts no accounts of its own;
  -- each later turn resolves its own sender's connections and accounts.
  destination_row.initial_personal_connection_delegations := '[]'::jsonb;
  destination_row.initial_mcp_account_bindings := '[]'::jsonb;
  destination_row.initial_connection_account_intent := NULL;
  destination_row.initial_personal_resource_attachment_intent := NULL;
  -- Organization and workspace provider-account authority carries over; a
  -- personal pool belongs to the source's creator.
  IF source_session.initial_xai_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_xai_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  IF source_session.initial_claude_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_claude_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  -- Agent scope binds to the person creating the session, exactly as create
  -- derives it. A user Memory selector needs that person.
  destination_row.scope_subject_id := CASE
    WHEN p_actor_subject_id ~ '^(user:|external_user:).+' THEN p_actor_subject_id END;
  IF destination_row.memory_scope = 'user' AND destination_row.scope_subject_id IS NULL THEN
    destination_row.memory_scope := 'off';
  END IF;

  INSERT INTO sessions SELECT (destination_row).*;

  -- Session-supplied MCP servers are part of the agent's tools. Headers the
  -- source's creator supplied are their credentials: another person's fork
  -- keeps only servers that carry none (public or connection-resolved ones).
  INSERT INTO session_mcp_servers
  SELECT (jsonb_populate_record(server_row, jsonb_build_object(
    'id', gen_random_uuid(), 'session_id', destination_session_id,
    'created_at', now(), 'updated_at', now()
  ))).*
  FROM session_mcp_servers server_row
  WHERE server_row.account_id = p_account_id
    AND server_row.workspace_id = p_source_workspace_id
    AND server_row.session_id = p_source_session_id
    AND (fork_same_creator OR server_row.headers_encrypted = '{}'::jsonb)
  ORDER BY server_row.created_at, server_row.server_id;

  INSERT INTO session_history_items (
    account_id, workspace_id, session_id, turn_id,
    position, item, item_ordered, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT p_account_id, p_source_workspace_id, destination_session_id, NULL,
      source_item.position, source_item.item, source_item.item_ordered, source_item.item_codec_version,
      source_item.active, source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at
    FROM pg_temp.opengeni_session_fork_history_spool source_item
    ORDER BY source_item.position;

  INSERT INTO session_events (
    account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  ) VALUES (
    p_account_id, p_source_workspace_id, destination_session_id, 1,
    'session.created', jsonb_build_object(
      'forked', true, 'sourceSessionId', p_source_session_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'visibility', public_destination_visibility,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
      'copiedHistoryItemCount', history_count
    ), clock_timestamp()
  ) RETURNING id INTO event_row_id;


  INSERT INTO opengeni_private.session_file_attachments
    (account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id,accepted_at)
  SELECT g.account_id,g.workspace_id,destination_session_id,g.file_id,g.accepted_by,event_row_id,clock_timestamp()
    FROM opengeni_private.session_file_attachments g
    WHERE g.account_id=p_account_id AND g.workspace_id=p_source_workspace_id AND g.session_id=p_source_session_id
    ON CONFLICT DO NOTHING;

  PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = p_source_workspace_id
  RETURNING counter.revision INTO destination_activity_revision;
  IF destination_activity_revision IS NULL THEN
    RAISE EXCEPTION 'session fork destination activity counter is unavailable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE sessions destination_session SET
    activity_revision = destination_activity_revision,
    activity_revision_pending_xid = NULL
  WHERE destination_session.id = destination_session_id
    AND destination_session.activity_revision_pending_xid
      = pg_current_xact_id()::text::bigint;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork activity was not finalized'
    USING ERRCODE = '55000'; END IF;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;

  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = visibility_write_capability_id;
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id, 'eventSequence', 1,
    'sessionId', destination_session_id, 'workspaceId', p_source_workspace_id,
    'visibility', p_destination_visibility, 'authorityEpoch', 1,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
    'copiedHistoryItemCount', history_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id; event_sequence := 1;
  session_id := destination_session_id; workspace_id := p_source_workspace_id;
  visibility := p_destination_visibility; authority_epoch := 1;
  copied_history_item_count := history_count; replay := false;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_activity_gate_state',
    CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END, true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    CASE WHEN previous_gate_workspace IS NULL THEN '' ELSE previous_gate_workspace END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$function$

$create$, data_schema);

  EXECUTE format($create$
CREATE OR REPLACE FUNCTION %1$I.fork_session_content(p_account_id uuid, p_source_workspace_id uuid, p_source_session_id uuid, p_actor_subject_id text, p_destination_workspace_id uuid, p_destination_visibility text, p_workspace_shared_acknowledged boolean, p_operation_key text, p_canonical_request_hash text, p_activation_version integer, p_source_event_id uuid)
 RETURNS TABLE(operation_id uuid, event_id uuid, event_sequence integer, session_id uuid, workspace_id uuid, visibility text, authority_epoch integer, copied_history_item_count integer, replay boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', %1$L, 'pg_temp'
AS $function$
DECLARE
  selected_event session_events%%ROWTYPE;
  selected_turn_id uuid;
  boundary_position numeric;
  boundary_matches integer;
  segment_start numeric;
  latest_reset_kind text;
  latest_reset_position numeric;
  latest_reset_payload jsonb;
  latest_reset_created_at timestamptz;
  later_reset_exists boolean;
  actor_membership organization_memberships%%ROWTYPE;
  source_session sessions%%ROWTYPE;
  destination_row sessions%%ROWTYPE;
  fork_same_creator boolean;
  destination_workspace workspaces%%ROWTYPE;
  receipt_row session_command_receipts%%ROWTYPE;
  destination_session_id uuid;
  history_count integer := 0;
  destination_activity_revision bigint;
  destination_depth integer;
  destination_depth_source text;
  destination_resources jsonb := '[]'::jsonb;
  event_row_id uuid;
  public_destination_visibility text;
  visibility_write_capability_id uuid := gen_random_uuid();
  previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
  previous_gate_state text := current_setting('opengeni.session_activity_gate_state', true);
  previous_gate_workspace text := current_setting(
    'opengeni.session_activity_gate_workspace_id', true
  );
  previous_visibility_capability text := current_setting(
    'opengeni.session_visibility_write_capability', true
  );
BEGIN
  IF p_account_id IS NULL OR p_source_workspace_id IS NULL
    OR p_source_session_id IS NULL OR p_actor_subject_id IS NULL
    OR p_destination_workspace_id IS NULL OR p_destination_visibility IS NULL
    OR p_workspace_shared_acknowledged IS NULL
    OR p_operation_key IS NULL OR p_canonical_request_hash IS NULL
    OR p_activation_version IS NULL
  THEN RAISE EXCEPTION 'session fork requires complete authority'
    USING ERRCODE = '42501'; END IF;
  IF p_account_id IS DISTINCT FROM opengeni_private.current_account_id()
    OR p_source_workspace_id IS DISTINCT FROM opengeni_private.current_workspace_id()
    OR p_actor_subject_id IS DISTINCT FROM opengeni_private.current_subject_id()
  THEN RAISE EXCEPTION 'session fork authority is invalid'
    USING ERRCODE = '42501'; END IF;
  IF p_destination_workspace_id IS DISTINCT FROM p_source_workspace_id
    OR p_destination_visibility NOT IN ('user_private', 'workspace_shared')
    OR (p_destination_visibility = 'user_private' AND p_workspace_shared_acknowledged)
    OR p_actor_subject_id <> btrim(p_actor_subject_id)
    OR length(p_actor_subject_id) NOT BETWEEN 1 AND 1024
    OR p_operation_key <> btrim(p_operation_key)
    OR length(p_operation_key) NOT BETWEEN 1 AND 1024
    OR p_canonical_request_hash !~ '^[0-9a-f]{64}$'
    OR p_activation_version <> 1
  THEN RAISE EXCEPTION 'session fork request is invalid'
    USING ERRCODE = '22023'; END IF;
  IF nullif(previous_gate_state, '') IS NOT NULL
    OR nullif(previous_gate_workspace, '') IS NOT NULL
  THEN RAISE EXCEPTION 'session fork requires ownership of the activity gate'
    USING ERRCODE = '55000'; END IF;
  IF NOT session_tenancy_product_activated(p_account_id, p_activation_version) THEN
    RAISE EXCEPTION 'session tenancy product surface is not activated for this organization'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'organization-membership:' || p_account_id::text, 0
  ));

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-tenancy:' || p_source_workspace_id::text, 0
  ));

  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    'session_visibility_activation', true);
  SELECT * INTO destination_workspace FROM workspaces workspace_row
  WHERE workspace_row.account_id = p_account_id
    AND workspace_row.id = p_source_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork workspace is unavailable'
    USING ERRCODE = '42501'; END IF;

  SELECT membership.* INTO actor_membership
  FROM organization_memberships membership
  WHERE membership.account_id = p_account_id
    AND membership.subject_id = p_actor_subject_id
    AND membership.status = 'active'
  FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT (
    actor_membership.personal_workspace_id = p_source_workspace_id
    OR EXISTS (
      SELECT 1 FROM workspace_memberships workspace_membership
      WHERE workspace_membership.account_id = p_account_id
        AND workspace_membership.workspace_id = p_source_workspace_id
        AND workspace_membership.subject_id = p_actor_subject_id
    )
  ) THEN RAISE EXCEPTION 'session fork requires active workspace authority'
    USING ERRCODE = '42501'; END IF;

  -- Resolve an already-applied receipt before inspecting mutable source state.
  -- The same still-authorized workspace actor can therefore recover the exact
  -- destination after a lost response even if the source owner later makes the
  -- source private. A new key still reaches the current source authorization
  -- check below and is denied.
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
    AND receipt.result ->> 'status' = 'applied';
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- Product decision, distinct from authority, and the same one migration 0323
  -- makes on the create path: a private destination inside a shared workspace
  -- requires the organization's private-session setting. A personal workspace
  -- is exempt exactly as it is there. This is deliberately placed after the
  -- keyed replay above and before any source read, so a fork that already
  -- committed still replays byte-identically after an owner disables the
  -- setting, while a fresh key fails closed with the same SQLSTATE the create
  -- path raises.
  IF p_destination_visibility = 'user_private'
    AND actor_membership.personal_workspace_id IS DISTINCT FROM p_source_workspace_id
    AND NOT organization_private_sessions_enabled(p_account_id)
  THEN
    RAISE EXCEPTION
      'private sessions are not enabled for this organization''s shared workspaces'
      USING ERRCODE = '55000';
  END IF;

  SELECT session.* INTO source_session FROM sessions session
  WHERE session.account_id = p_account_id
    AND session.workspace_id = p_source_workspace_id
    AND session.id = p_source_session_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork source session is unavailable'
    USING ERRCODE = 'P0002'; END IF;
  -- A private source remains owner-only. A workspace-shared source follows
  -- current workspace authority, and the fork becomes a fresh session owned
  -- by the actor. This is what lets any authorized collaborator fork shared
  -- work privately without retaining the source owner's authority.
  IF source_session.visibility = 'user_private' AND (
    source_session.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
    OR source_session.owner_subject_id IS DISTINCT FROM actor_membership.subject_id
  )
  THEN RAISE EXCEPTION 'session fork source session is private'
    USING ERRCODE = '42501'; END IF;

  INSERT INTO session_command_receipts (
    account_id, workspace_id, actor_type, actor_subject_id, action,
    target_session_id, operation_key, canonical_request_hash
  ) VALUES (
    p_account_id, p_source_workspace_id, 'human', p_actor_subject_id,
    'session.fork', p_source_session_id, p_operation_key, p_canonical_request_hash
  ) ON CONFLICT DO NOTHING;
  SELECT receipt.* INTO receipt_row FROM session_command_receipts receipt
  WHERE receipt.account_id = p_account_id
    AND receipt.workspace_id = p_source_workspace_id
    AND receipt.actor_type = 'human' AND receipt.actor_subject_id = p_actor_subject_id
    AND receipt.actor_attempt_id IS NULL AND receipt.action = 'session.fork'
    AND receipt.target_session_id = p_source_session_id
    AND receipt.target_turn_id IS NULL AND receipt.operation_key = p_operation_key
  FOR UPDATE;
  IF receipt_row.canonical_request_hash <> p_canonical_request_hash THEN
    RAISE EXCEPTION 'session fork idempotency conflict' USING ERRCODE = '23505';
  END IF;
  IF receipt_row.result ->> 'status' = 'applied' THEN
    operation_id := receipt_row.id;
    event_id := nullif(receipt_row.result ->> 'eventId', '')::uuid;
    event_sequence := (receipt_row.result ->> 'eventSequence')::integer;
    session_id := (receipt_row.result ->> 'sessionId')::uuid;
    workspace_id := (receipt_row.result ->> 'workspaceId')::uuid;
    visibility := receipt_row.result ->> 'visibility'; authority_epoch := 1;
    copied_history_item_count :=
      (receipt_row.result ->> 'copiedHistoryItemCount')::integer;
    replay := true; RETURN NEXT; RETURN;
  END IF;

  -- The acknowledgement is content-exposure evidence, not a blanket checkbox:
  -- it is required only when private source content crosses into workspace scope.
  IF source_session.visibility = 'user_private'
    AND p_destination_visibility = 'workspace_shared'
    AND NOT p_workspace_shared_acknowledged
  THEN RAISE EXCEPTION 'private-to-workspace fork requires explicit acknowledgement'
    USING ERRCODE = '22023'; END IF;

  -- Active source work is allowed: the held locks stabilize the selected prefix.

  SELECT coalesce(jsonb_agg(
    CASE WHEN resource.value ->> 'connectionType' = 'github_personal'
      THEN resource.value
        - 'provider' - 'connectionType' - 'credentialBindingId' - 'access'
        - 'repositoryId' - 'installationId' - 'projectId' - 'connectionId'
        - 'githubInstallationId' - 'githubRepositoryId'
      ELSE resource.value
        - 'credentialBindingId' - 'connectionId' - 'installationId'
        - 'projectId' - 'githubInstallationId'
    END
    ORDER BY resource.ordinality
  ), '[]'::jsonb) INTO destination_resources
  FROM jsonb_array_elements(source_session.resources)
    WITH ORDINALITY AS resource(value, ordinality);


  -- Authority, source locks, and keyed replay have already been
  -- established by the unchanged lifecycle prefix. Never infer a history
  -- boundary from timestamp order or manufacture model input from audit events.
  SELECT event.* INTO selected_event FROM session_events event
    WHERE event.account_id = p_account_id
      AND event.workspace_id = p_source_workspace_id
      AND event.session_id = p_source_session_id AND event.id = p_source_event_id
      AND event.type IN ('user.message', 'agent.message.completed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected message is not available for forking' USING ERRCODE = '22023';
  END IF;
  IF selected_event.type = 'user.message' THEN
    SELECT turn.id INTO selected_turn_id FROM session_turns turn
      WHERE turn.account_id = p_account_id AND turn.workspace_id = p_source_workspace_id
        AND turn.session_id = p_source_session_id AND turn.trigger_event_id = selected_event.id;
    SELECT min(history.position), count(*) INTO boundary_position, boundary_matches
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id AND history.turn_id = selected_turn_id
        AND history.item ->> 'role' = 'user'
        AND NOT EXISTS (SELECT 1 FROM session_events summary_event
          WHERE summary_event.account_id = p_account_id
            AND summary_event.workspace_id = p_source_workspace_id
            AND summary_event.session_id = p_source_session_id
            AND summary_event.type = 'session.context.compacted'
            AND summary_event.payload ->> 'summaryPosition' = history.position::text)
        AND NOT EXISTS (SELECT 1 FROM session_history_items earlier_user
          WHERE earlier_user.account_id = history.account_id
            AND earlier_user.workspace_id = history.workspace_id
            AND earlier_user.session_id = history.session_id
            AND earlier_user.turn_id = selected_turn_id
            AND earlier_user.item ->> 'role' = 'user'
            AND earlier_user.position < history.position);
  ELSE
    SELECT min(history.position), count(*) INTO boundary_position, boundary_matches
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id AND history.turn_id = selected_event.turn_id
        AND history.item ->> 'role' = 'assistant'
        AND CASE WHEN jsonb_typeof(history.item -> 'content') = 'array' THEN
          (SELECT string_agg(part.value ->> 'text', '' ORDER BY part.ordinality)
           FROM jsonb_array_elements(history.item -> 'content') WITH ORDINALITY part(value, ordinality)
           WHERE part.value ->> 'type' IN ('output_text', 'text'))
          ELSE history.item ->> 'content' END = selected_event.payload ->> 'text';
  END IF;
  IF boundary_matches <> 1 OR boundary_position IS NULL THEN
    RAISE EXCEPTION 'This message has no unambiguous retained conversation boundary' USING ERRCODE = '22023';
  END IF;
  -- The history live at the boundary starts at the latest context reset
  -- positioned at or before it (see migration 0778).
  SELECT reset.kind, reset.position, reset.payload, reset.created_at
    INTO latest_reset_kind, latest_reset_position, latest_reset_payload, latest_reset_created_at
  FROM (
    SELECT 'compaction' AS kind, summary_history.position, compaction_event.payload,
      summary_history.created_at
    FROM session_events compaction_event
    JOIN session_history_items summary_history
      ON summary_history.account_id = compaction_event.account_id
      AND summary_history.workspace_id = compaction_event.workspace_id
      AND summary_history.session_id = compaction_event.session_id
      AND summary_history.position::text = compaction_event.payload ->> 'summaryPosition'
    WHERE compaction_event.account_id = p_account_id
      AND compaction_event.workspace_id = p_source_workspace_id
      AND compaction_event.session_id = p_source_session_id
      AND compaction_event.type = 'session.context.compacted'
      AND summary_history.position <= boundary_position
    UNION ALL
    SELECT 'clear', marker_history.position, clear_event.payload, marker_history.created_at
    FROM session_events clear_event
    JOIN session_history_items marker_history
      ON marker_history.account_id = clear_event.account_id
      AND marker_history.workspace_id = clear_event.workspace_id
      AND marker_history.session_id = clear_event.session_id
      AND marker_history.position::text = clear_event.payload ->> 'markerPosition'
    WHERE clear_event.account_id = p_account_id
      AND clear_event.workspace_id = p_source_workspace_id
      AND clear_event.session_id = p_source_session_id
      AND clear_event.type = 'session.context.cleared'
      AND marker_history.position <= boundary_position
  ) reset
  ORDER BY reset.position DESC
  LIMIT 1;
  IF latest_reset_kind IS NULL THEN
    segment_start := '-Infinity'::numeric;
  ELSIF latest_reset_kind = 'clear' THEN
    segment_start := latest_reset_position;
  ELSIF jsonb_typeof(latest_reset_payload -> 'replacementFromPosition') = 'number' THEN
    segment_start := (latest_reset_payload ->> 'replacementFromPosition')::numeric;
  ELSE
    -- An earlier receipt: the replacement rows share the summary's insert
    -- transaction, positioned after every row that existed before it. This
    -- identifies that transaction's rows; it never orders rows by time.
    SELECT coalesce(floor(max(earlier.position)) + 1, 0) INTO segment_start
    FROM session_history_items earlier
    WHERE earlier.account_id = p_account_id AND earlier.workspace_id = p_source_workspace_id
      AND earlier.session_id = p_source_session_id
      AND earlier.position < latest_reset_position
      AND earlier.created_at <> latest_reset_created_at;
  END IF;
  later_reset_exists := EXISTS (
    SELECT 1 FROM session_events reset_event
    JOIN session_history_items reset_history
      ON reset_history.account_id = reset_event.account_id
      AND reset_history.workspace_id = reset_event.workspace_id
      AND reset_history.session_id = reset_event.session_id
      AND reset_history.position::text = CASE reset_event.type
        WHEN 'session.context.compacted' THEN reset_event.payload ->> 'summaryPosition'
        ELSE reset_event.payload ->> 'markerPosition' END
    WHERE reset_event.account_id = p_account_id
      AND reset_event.workspace_id = p_source_workspace_id
      AND reset_event.session_id = p_source_session_id
      AND reset_event.type IN ('session.context.compacted', 'session.context.cleared')
      AND reset_history.position > boundary_position
  );
  -- Fail closed unless the retained rows prove exactly that live history.
  IF (latest_reset_kind = 'compaction' AND (
      latest_reset_position <> trunc(latest_reset_position)
      OR segment_start > latest_reset_position))
    OR EXISTS (SELECT 1 FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id
        AND history.active AND history.position < segment_start)
    OR EXISTS (SELECT 1 FROM session_history_items history
    WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
      AND history.session_id = p_source_session_id
      AND history.position >= segment_start
      AND history.position <= boundary_position
      AND ((NOT history.active AND NOT later_reset_exists)
        OR (history.position <> trunc(history.position) AND NOT ((
          history.item ->> 'type' = 'message'
          AND history.item ->> 'role' = 'developer'
          AND jsonb_typeof(history.item -> 'content') = 'string'
          AND ((starts_with(history.item ->> 'content', E'<opengeni_skill_catalog>\n') AND right(history.item ->> 'content', length(E'\n</opengeni_skill_catalog>')) = E'\n</opengeni_skill_catalog>') OR (starts_with(history.item ->> 'content', E'<opengeni_workspace_governance>\n') AND right(history.item ->> 'content', length(E'\n</opengeni_workspace_governance>')) = E'\n</opengeni_workspace_governance>'))
          AND TRUE
        ) IS TRUE) AND (
          history.item ->> 'type' = 'unknown'
          AND history.item #> '{opengeniReasoningConfiguration,version}' = '1'::jsonb
          AND history.item #>> '{opengeniReasoningConfiguration,baselineEffort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND history.item #>> '{opengeniReasoningConfiguration,effort}'
            IN ('low', 'medium', 'high', 'xhigh', 'max')
          AND jsonb_typeof(history.item #> '{opengeniReasoningConfiguration,turnId}') = 'string'
          AND history.item #>> '{providerData,type}' = 'configuration_update'
          AND history.item #>> '{providerData,reasoning,effort}' =
            history.item #>> '{opengeniReasoningConfiguration,effort}'
        ) IS NOT TRUE)
        OR (history.item ->> 'type' = 'compaction' AND NOT EXISTS (
      SELECT 1 FROM session_events compaction_event
      WHERE compaction_event.account_id = p_account_id
        AND compaction_event.workspace_id = p_source_workspace_id
        AND compaction_event.session_id = p_source_session_id
        AND compaction_event.type = 'session.context.compacted'
        AND compaction_event.payload ->> 'summaryPosition' = history.position::text
    )))) THEN
    RAISE EXCEPTION 'Forking at a message is unavailable after conversation compaction' USING ERRCODE = '22023';
  END IF;
  -- A selected assistant message must not split an in-flight tool exchange.
  IF EXISTS (
    WITH prefix AS (
      SELECT history.position, history.item ->> 'type' AS item_type,
        (SELECT identity.value #>> '{}' FROM (VALUES
          (1, history.item -> 'callId'), (2, history.item -> 'call_id'),
          (3, history.item #> '{providerData,callId}'),
          (4, history.item #> '{providerData,call_id}'), (5, history.item -> 'id')
        ) AS identity(priority, value)
        WHERE jsonb_typeof(identity.value) = 'string' AND identity.value #>> '{}' <> ''
        ORDER BY identity.priority LIMIT 1) AS call_id
      FROM session_history_items history
      WHERE history.account_id = p_account_id AND history.workspace_id = p_source_workspace_id
        AND history.session_id = p_source_session_id
        AND history.position >= segment_start AND history.position <= boundary_position
    )
    SELECT 1 FROM prefix call
    WHERE call.item_type IN ('function_call', 'computer_call', 'shell_call', 'apply_patch_call', 'tool_search_call')
      AND NOT EXISTS (SELECT 1 FROM prefix result
        WHERE result.position > call.position AND result.call_id = call.call_id
          AND result.item_type = ANY (CASE call.item_type
            WHEN 'function_call' THEN ARRAY['function_call_result', 'function_call_output']
            WHEN 'computer_call' THEN ARRAY['computer_call_result', 'computer_call_output']
            WHEN 'shell_call' THEN ARRAY['shell_call_output']
            WHEN 'apply_patch_call' THEN ARRAY['apply_patch_call_output']
            WHEN 'tool_search_call' THEN ARRAY['tool_search_output']
          END))
  ) THEN
    RAISE EXCEPTION 'This message splits an unfinished tool exchange' USING ERRCODE = '22023';
  END IF;
  DROP TABLE IF EXISTS pg_temp.opengeni_session_fork_history_spool;

  CREATE TEMP TABLE opengeni_session_fork_history_spool (
    position numeric NOT NULL,
    item jsonb NOT NULL, item_ordered json NOT NULL,
    item_codec_version integer,
    active boolean NOT NULL,
    provider_artifact_invalidated_at timestamptz,
    provider_artifact_invalidation_reason text,
    provider_artifact_invalidated_by_attempt_id uuid,
    created_at timestamptz NOT NULL
  ) ON COMMIT DROP;
  INSERT INTO pg_temp.opengeni_session_fork_history_spool (
    position, item, item_ordered, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT source_item.position, source_item.item, source_item.item_ordered,
      source_item.item_codec_version, true,
      source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id,
      source_item.created_at
    FROM session_history_items source_item
    WHERE source_item.account_id = p_account_id
      AND source_item.workspace_id = p_source_workspace_id
      AND source_item.session_id = p_source_session_id
      AND source_item.position >= segment_start
      AND source_item.position <= boundary_position
    ORDER BY source_item.position;
  GET DIAGNOSTICS history_count = ROW_COUNT;

  SELECT coalesce(
      CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
        THEN (destination_workspace.settings ->> 'maxNestedAgentDepth')::integer END,
      configuration.max_nested_agent_depth
    ),
    CASE WHEN (destination_workspace.settings ->> 'maxNestedAgentDepth') ~ '^\d+$'
      THEN 'workspace' ELSE configuration.policy_source END
  INTO destination_depth, destination_depth_source
  FROM nested_agent_depth_configuration configuration
  WHERE configuration.singleton = true;
  IF destination_depth IS NULL OR destination_depth_source IS NULL THEN
    RAISE EXCEPTION 'session fork destination depth policy is unavailable'
      USING ERRCODE = '55000';
  END IF;

  destination_session_id := gen_random_uuid();
  public_destination_visibility := CASE p_destination_visibility
    WHEN 'user_private' THEN 'private' ELSE 'workspace' END;
  INSERT INTO session_visibility_write_capabilities (
    backend_pid, transaction_id, capability_id
  ) VALUES (pg_backend_pid(), pg_current_xact_id(), visibility_write_capability_id);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    visibility_write_capability_id::text, true);
  PERFORM set_config('opengeni.session_activity_gate_state', 'open', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    p_source_workspace_id::text, true);

  -- A fork is the same agent as its source. Start from the complete source row
  -- so every agent setting, including columns added later, carries over. Then
  -- replace only what belongs to the new session or to the person who created
  -- the source. session-fork-agent-parity-postgres.test.ts classifies every
  -- column; a new column must be placed on one side or the other.
  destination_row := source_session;
  -- Settings bound to the source's creator personally carry over only when
  -- that same person forks a top-level session they created.
  fork_same_creator := source_session.parent_session_id IS NULL
    AND source_session.created_by_kind = 'subject'
    AND source_session.created_by_subject_id = p_actor_subject_id;

  -- Identity, ownership and provenance of the new session.
  destination_row.id := destination_session_id;
  destination_row.account_id := p_account_id;
  destination_row.workspace_id := p_source_workspace_id;
  destination_row.created_at := now();
  destination_row.updated_at := now();
  destination_row.authority_inserted_at := transaction_timestamp();
  destination_row.created_by_kind := 'subject';
  destination_row.created_by_subject_id := p_actor_subject_id;
  destination_row.created_by_context := jsonb_build_object(
      'fork', true,
      'sourceSessionId', p_source_session_id, 'sourceEventId', p_source_event_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged
    );
  destination_row.owner_organization_membership_id := actor_membership.id;
  destination_row.owner_subject_id := actor_membership.subject_id;
  -- Both visibility columns record the audience the fork's creator asked for;
  -- the source's creation request is its own history.
  destination_row.visibility := p_destination_visibility;
  destination_row.create_requested_visibility := p_destination_visibility;
  destination_row.authority_epoch := 1;
  destination_row.execution_authority_epoch := 1;
  destination_row.forked_from_session_id := p_source_session_id;
  destination_row.forked_from_authority_epoch := source_session.authority_epoch;
  destination_row.forked_from_visibility := source_session.visibility;
  destination_row.forked_at := clock_timestamp();
  destination_row.forked_by_organization_membership_id := actor_membership.id;
  destination_row.create_idempotency_key := NULL;
  destination_row.agent_creation_attempt_id := NULL;
  destination_row.imported_archive_import_id := NULL;
  destination_row.imported_archive_imported_at := NULL;
  destination_row.imported_archive_request_hash := NULL;
  destination_row.imported_archive_subject_id := NULL;
  destination_row.imported_archive_next_offset := NULL;
  -- Historical end-user labels; new sessions never write them.
  destination_row.end_user_source := NULL;
  destination_row.end_user_id := NULL;
  -- A Site audience is derived by the server for a Site conversation itself.
  destination_row.site_id := NULL;
  destination_row.site_access_root_id := NULL;
  destination_row.site_viewer_principal := NULL;
  destination_row.site_owner_subject_id := NULL;
  -- Metadata keeps the agent's settings (model, reasoning, execution policy,
  -- creation configuration). Links to a schedule run, a Site, or this
  -- session's own fork runtime receipt identify the source, not the agent.
  destination_row.metadata := source_session.metadata
    - 'scheduledTaskId' - 'scheduledTaskRunId' - 'opengeniPublishedSite'
    - '_opengeniSiteOrigin' - 'forkRuntimeConfiguration';

  -- A fork is the root of its own tree and keeps the nesting limit the source
  -- chose for itself; otherwise the destination workspace policy applies.
  destination_row.parent_session_id := NULL;
  destination_row.parent_turn_id := NULL;
  destination_row.root_session_id := destination_session_id;
  destination_row.nested_agent_depth := 0;
  destination_row.max_nested_agent_depth_override := CASE
    WHEN source_session.nested_agent_depth_policy_source = 'session'
    THEN source_session.effective_max_nested_agent_depth END;
  destination_row.effective_max_nested_agent_depth :=
    coalesce(destination_row.max_nested_agent_depth_override, destination_depth);
  destination_row.nested_agent_depth_policy_source := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN destination_depth_source ELSE 'session' END;
  destination_row.nested_agent_depth_policy_session_id := CASE
    WHEN destination_row.max_nested_agent_depth_override IS NULL
    THEN NULL ELSE destination_session_id END;

  -- A new session starts idle in its own sandbox group, with no runs, queue,
  -- controls, waits, archive or measurements of its own yet.
  destination_row.status := 'idle';
  destination_row.temporal_workflow_id := 'session-' || destination_session_id::text;
  destination_row.active_turn_id := NULL;
  destination_row.execution_context_turn_id := NULL;
  destination_row.last_sequence := 1;
  destination_row.queue_version := 0;
  destination_row.queue_head_position := 0;
  destination_row.queue_tail_position := 0;
  destination_row.sandbox_group_id := destination_session_id;
  destination_row.active_sandbox_id := NULL;
  destination_row.active_epoch := 0;
  destination_row.working_dir := NULL;
  destination_row.last_input_tokens := NULL;
  destination_row.compact_requested := false;
  destination_row.direct_control_state := 'active';
  destination_row.direct_pause_revision := NULL;
  destination_row.subtree_run_override_revision := NULL;
  destination_row.control_version := 0;
  destination_row.direct_control_reason := NULL;
  destination_row.direct_control_changed_by := NULL;
  destination_row.direct_control_changed_at := NULL;
  destination_row.activity_revision := 0;
  destination_row.activity_revision_pending_xid := NULL;
  destination_row.activity_xid := '0'::xid8;
  destination_row.input_wait_turn_id := NULL;
  destination_row.input_wait_until := NULL;
  destination_row.input_wait_reason := NULL;
  destination_row.input_wait_set_at := NULL;
  destination_row.admission_block := NULL;
  destination_row.content_archive_state := NULL;
  destination_row.content_archive_started_at := NULL;
  destination_row.content_archived_at := NULL;
  destination_row.content_archive := NULL;
  destination_row.content_archive_purged_at := NULL;
  -- Optimistic edit counter of this row's tool policy, not the policy itself.
  destination_row.tool_policy_version := 1;
  destination_row.resources := destination_resources;
  -- Variable Sets are retired; only an explicit fork runtime request may
  -- select runtime setup, and that path now refuses Variable Sets.
  destination_row.variable_set_ids := '[]'::jsonb;
  destination_row.variable_set_id := NULL;
  -- Another person's personal Rig stays with them.
  IF source_session.rig_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM rigs rig_row
    WHERE rig_row.account_id = p_account_id AND rig_row.id = source_session.rig_id
      AND rig_row.authority_scope = 'user'
      AND rig_row.owner_organization_membership_id IS DISTINCT FROM actor_membership.id
  ) THEN
    destination_row.rig_id := NULL;
    destination_row.rig_version_id := NULL;
  END IF;

  -- What the source's creator accepted for the source's first turn stays with
  -- that turn. A fork starts no first turn and accepts no accounts of its own;
  -- each later turn resolves its own sender's connections and accounts.
  destination_row.initial_personal_connection_delegations := '[]'::jsonb;
  destination_row.initial_mcp_account_bindings := '[]'::jsonb;
  destination_row.initial_connection_account_intent := NULL;
  destination_row.initial_personal_resource_attachment_intent := NULL;
  -- Organization and workspace provider-account authority carries over; a
  -- personal pool belongs to the source's creator.
  IF source_session.initial_xai_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_xai_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  IF source_session.initial_claude_provider_account_authority_snapshot ->> 'scope' = 'user'
    AND NOT fork_same_creator THEN
    destination_row.initial_claude_provider_account_authority_snapshot :=
      '{"scope":"workspace","version":1}'::jsonb;
  END IF;
  -- Agent scope binds to the person creating the session, exactly as create
  -- derives it. A user Memory selector needs that person.
  destination_row.scope_subject_id := CASE
    WHEN p_actor_subject_id ~ '^(user:|external_user:).+' THEN p_actor_subject_id END;
  IF destination_row.memory_scope = 'user' AND destination_row.scope_subject_id IS NULL THEN
    destination_row.memory_scope := 'off';
  END IF;

  INSERT INTO sessions SELECT (destination_row).*;

  -- Session-supplied MCP servers are part of the agent's tools. Headers the
  -- source's creator supplied are their credentials: another person's fork
  -- keeps only servers that carry none (public or connection-resolved ones).
  INSERT INTO session_mcp_servers
  SELECT (jsonb_populate_record(server_row, jsonb_build_object(
    'id', gen_random_uuid(), 'session_id', destination_session_id,
    'created_at', now(), 'updated_at', now()
  ))).*
  FROM session_mcp_servers server_row
  WHERE server_row.account_id = p_account_id
    AND server_row.workspace_id = p_source_workspace_id
    AND server_row.session_id = p_source_session_id
    AND (fork_same_creator OR server_row.headers_encrypted = '{}'::jsonb)
  ORDER BY server_row.created_at, server_row.server_id;

  INSERT INTO session_history_items (
    account_id, workspace_id, session_id, turn_id,
    position, item, item_ordered, item_codec_version, active,
    provider_artifact_invalidated_at, provider_artifact_invalidation_reason,
    provider_artifact_invalidated_by_attempt_id, created_at
  ) SELECT p_account_id, p_source_workspace_id, destination_session_id, NULL,
      source_item.position, source_item.item, source_item.item_ordered, source_item.item_codec_version,
      source_item.active, source_item.provider_artifact_invalidated_at,
      source_item.provider_artifact_invalidation_reason,
      source_item.provider_artifact_invalidated_by_attempt_id, source_item.created_at
    FROM pg_temp.opengeni_session_fork_history_spool source_item
    ORDER BY source_item.position;

  INSERT INTO session_events (
    account_id, workspace_id, session_id, sequence, type, payload, occurred_at
  ) VALUES (
    p_account_id, p_source_workspace_id, destination_session_id, 1,
    'session.created', jsonb_build_object(
      'forked', true, 'sourceSessionId', p_source_session_id, 'sourceEventId', p_source_event_id,
      'sourceAuthorityEpoch', source_session.authority_epoch,
      'sourceVisibility', CASE source_session.visibility
        WHEN 'user_private' THEN 'private' ELSE 'workspace' END,
      'visibility', public_destination_visibility,
      'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
      'copiedHistoryItemCount', history_count
    ), clock_timestamp()
  ) RETURNING id INTO event_row_id;


  INSERT INTO opengeni_private.session_file_attachments
    (account_id,workspace_id,session_id,file_id,accepted_by,accepted_event_id,accepted_at)
  SELECT g.account_id,g.workspace_id,destination_session_id,g.file_id,g.accepted_by,event_row_id,clock_timestamp()
    FROM opengeni_private.session_file_attachments g
    WHERE g.account_id=p_account_id AND g.workspace_id=p_source_workspace_id AND g.session_id=p_source_session_id

      AND EXISTS (SELECT 1 FROM session_events e WHERE e.id=g.accepted_event_id
        AND e.account_id=p_account_id AND e.workspace_id=p_source_workspace_id
        AND e.session_id=p_source_session_id AND e.sequence<=selected_event.sequence)
    ON CONFLICT DO NOTHING;

  PERFORM set_config('opengeni.session_activity_gate_state', 'preparing', true);
  SET CONSTRAINTS ALL IMMEDIATE;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard DEFERRED;
  PERFORM set_config('opengeni.session_activity_gate_state', 'finalizing', true);
  UPDATE workspace_session_activity_revisions counter
  SET revision = counter.revision + 1
  WHERE counter.workspace_id = p_source_workspace_id
  RETURNING counter.revision INTO destination_activity_revision;
  IF destination_activity_revision IS NULL THEN
    RAISE EXCEPTION 'session fork destination activity counter is unavailable'
      USING ERRCODE = '55000';
  END IF;
  UPDATE sessions destination_session SET
    activity_revision = destination_activity_revision,
    activity_revision_pending_xid = NULL
  WHERE destination_session.id = destination_session_id
    AND destination_session.activity_revision_pending_xid
      = pg_current_xact_id()::text::bigint;
  IF NOT FOUND THEN RAISE EXCEPTION 'session fork activity was not finalized'
    USING ERRCODE = '55000'; END IF;
  SET CONSTRAINTS sessions_activity_insert_commit_guard,
    sessions_activity_update_commit_guard IMMEDIATE;

  PERFORM set_config('opengeni.session_activity_gate_state', '', true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id', '', true);
  DELETE FROM session_visibility_write_capabilities capability
  WHERE capability.backend_pid = pg_backend_pid()
    AND capability.transaction_id = pg_current_xact_id()
    AND capability.capability_id = visibility_write_capability_id;
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);

  UPDATE session_command_receipts SET result = jsonb_build_object(
    'status', 'applied', 'eventId', event_row_id, 'eventSequence', 1,
    'sessionId', destination_session_id, 'workspaceId', p_source_workspace_id,
    'visibility', p_destination_visibility, 'authorityEpoch', 1,
    'workspaceSharedAcknowledged', p_workspace_shared_acknowledged,
    'copiedHistoryItemCount', history_count
  ), updated_at = clock_timestamp() WHERE id = receipt_row.id;

  operation_id := receipt_row.id; event_id := event_row_id; event_sequence := 1;
  session_id := destination_session_id; workspace_id := p_source_workspace_id;
  visibility := p_destination_visibility; authority_epoch := 1;
  copied_history_item_count := history_count; replay := false;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  RETURN NEXT;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle',
    CASE WHEN previous_lifecycle IS NULL THEN '' ELSE previous_lifecycle END, true);
  PERFORM set_config('opengeni.session_activity_gate_state',
    CASE WHEN previous_gate_state IS NULL THEN '' ELSE previous_gate_state END, true);
  PERFORM set_config('opengeni.session_activity_gate_workspace_id',
    CASE WHEN previous_gate_workspace IS NULL THEN '' ELSE previous_gate_workspace END, true);
  PERFORM set_config('opengeni.session_visibility_write_capability',
    CASE WHEN previous_visibility_capability IS NULL THEN '' ELSE previous_visibility_capability END,
    true);
  RAISE;
END
$function$

$create$, data_schema);
END
$install$;

DROP TRIGGER managed_accounts_subscription_codex_cutover_seed ON managed_accounts;
DROP TRIGGER sessions_codex_last_workspace_guard ON sessions;
DROP TRIGGER sessions_codex_pinned_workspace_guard ON sessions;

-- Remove just the retired columns from the invoker/barrier projection. Dropping
-- the view with RESTRICT refuses unexpected schema-bound readers. Restore its
-- exact effective table grants, not whatever default privileges are current.
DO $view$
DECLARE
  data_schema text := current_schema();
  view_oid oid;
  view_owner oid;
  view_acl aclitem[];
  grant_row record;
  grantee_sql text;
BEGIN
  SELECT c.oid, c.relowner, coalesce(c.relacl, acldefault('r', c.relowner))
    INTO STRICT view_oid, view_owner, view_acl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = data_schema AND c.relname = 'insights_audience_sessions';
  IF pg_get_userbyid(view_owner) <> current_user THEN
    RAISE EXCEPTION 'Insights view must have the migration owner before contraction'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = view_oid AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'Insights view column grants require explicit review before contraction'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format('DROP VIEW %I.insights_audience_sessions RESTRICT', data_schema);
  EXECUTE format($create_view$
CREATE VIEW %1$I.insights_audience_sessions WITH (security_invoker='true', security_barrier='true') AS
 SELECT id,
    status,
    initial_message,
    resources,
    tools,
    metadata,
    model,
    sandbox_backend,
    temporal_workflow_id,
    active_turn_id,
    last_sequence,
    created_at,
    updated_at,
    account_id,
    workspace_id,
    variable_set_id,
    first_party_mcp_permissions,
    parent_session_id,
    last_input_tokens,
    compact_requested,
    create_idempotency_key,
    sandbox_os,
    sandbox_group_id,
    title,
    title_source,
    active_sandbox_id,
    active_epoch,
    working_dir,
    instructions,
    rig_id,
    rig_version_id,
    queue_version,
    queue_head_position,
    queue_tail_position,
    direct_control_state,
    direct_pause_revision,
    subtree_run_override_revision,
    control_version,
    direct_control_reason,
    direct_control_changed_by,
    direct_control_changed_at,
    tool_policy,
    activity_revision,
    created_by_kind,
    created_by_subject_id,
    created_by_context,
    initial_model_context,
    root_session_id,
    nested_agent_depth,
    max_nested_agent_depth_override,
    effective_max_nested_agent_depth,
    nested_agent_depth_policy_source,
    nested_agent_depth_policy_session_id,
    tool_policy_version,
    skills,
    first_party_mcp_tools,
    codex_compaction_mode,
    initial_personal_connection_delegations,
    parent_turn_id,
    policy_role,
    initial_message_codec_version,
    activity_revision_pending_xid,
    owner_organization_membership_id,
    visibility,
    authority_epoch,
    forked_from_session_id,
    forked_from_authority_epoch,
    forked_from_visibility,
    forked_at,
    forked_by_organization_membership_id,
    channel_id,
    owner_subject_id,
    initial_xai_provider_account_authority_snapshot,
    reasoning_effort,
    latency_mode,
    initial_personal_resource_attachment_intent,
    create_requested_visibility,
    variable_set_ids,
    input_wait_turn_id,
    input_wait_until,
    input_wait_reason,
    input_wait_set_at,
    agent_access,
    end_user_source,
    end_user_id,
    memory_scope,
    scope_subject_id,
    admission_block,
    mcp_approval_policies,
    initial_mcp_account_bindings,
    execution_authority_epoch,
    code_search_enabled,
    agent_config,
    imported_archive_import_id,
    imported_archive_imported_at,
    imported_archive_request_hash,
    imported_archive_subject_id,
    imported_archive_next_offset,
    initial_claude_provider_account_authority_snapshot,
    execution_context_turn_id,
    keep_live,
    content_archive_state,
    content_archive_started_at,
    content_archived_at,
    content_archive,
    content_archive_purged_at,
    authority_inserted_at,
    vault_policy,
    initial_connection_account_intent,
    site_id,
    site_access_root_id,
    site_viewer_principal,
    site_owner_subject_id
   FROM %1$I.sessions
  WHERE %1$I.session_site_actor_visible(site_id, site_access_root_id, root_session_id, site_viewer_principal, site_owner_subject_id);
$create_view$, data_schema);
  FOR grant_row IN
    SELECT DISTINCT acl.grantee FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) acl
    WHERE c.oid = format('%I.insights_audience_sessions', data_schema)::regclass
      AND acl.grantee <> view_owner
  LOOP
    grantee_sql := CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END;
    EXECUTE format('REVOKE ALL ON TABLE %I.insights_audience_sessions FROM %s', data_schema, grantee_sql);
  END LOOP;
  FOR grant_row IN SELECT * FROM aclexplode(view_acl) WHERE grantee <> view_owner LOOP
    grantee_sql := CASE WHEN grant_row.grantee = 0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid(grant_row.grantee)) END;
    EXECUTE format('GRANT %s ON TABLE %I.insights_audience_sessions TO %s%s',
      grant_row.privilege_type, data_schema, grantee_sql,
      CASE WHEN grant_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END
$view$;
ALTER TABLE sessions
  DROP COLUMN codex_pinned_credential_id RESTRICT,
  DROP COLUMN codex_last_credential_id RESTRICT,
  DROP COLUMN codex_pin_source RESTRICT;

DROP TABLE
  claude_credential_leases, claude_rotation_settings, claude_session_account_pins,
  claude_subscription_account_usage, claude_subscription_credentials,
  codex_apps_settings, codex_credential_leases, codex_rotation_settings,
  codex_subscription_credentials, codex_turn_source_bindings,
  organization_codex_rotation_settings, subscription_provider_cutovers,
  workspace_codex_subscription_preferences, xai_credential_leases,
  xai_rotation_settings, xai_session_account_pins, xai_subscription_credentials
RESTRICT;

DO $drop$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('DROP FUNCTION %1$I.capture_legacy_codex_turn_sources(uuid,uuid), %1$I.resolve_workspace_codex_subscription_source(uuid,uuid) RESTRICT', data_schema);
END
$drop$;
DROP FUNCTION
  opengeni_private.codex_credential_serves_turn(uuid,uuid,uuid,uuid),
  opengeni_private.codex_credential_serves_workspace(uuid,uuid,uuid),
  opengeni_private.codex_organization_live_lease_count(uuid,uuid,uuid),
  opengeni_private.enforce_codex_credential_workspace(),
  opengeni_private.enforce_codex_lease_source(),
  opengeni_private.clear_workspace_codex_session_affinity(),
  opengeni_private.prevent_organization_codex_disconnect_with_live_leases(),
  opengeni_private.seed_subscription_codex_cutover()
RESTRICT;
