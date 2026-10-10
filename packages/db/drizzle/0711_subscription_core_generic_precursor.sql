-- deployment-mode: rolling
-- M4 PR 0a, the generic precursor (design
-- docs/design/subscription-core-2026-10-07.md, 5.3 "PR sequence" row 0 and
-- "Findings in earlier merged work"). Provider-neutral groundwork every later
-- provider cutover relies on. Rolling: old binaries keep working; nothing
-- here reads a provider's v2 authority before that provider's own receipt.
--
-- 1. Cutover receipts: one owner-only row per provider whose drained cutover
--    committed, and one SQL readiness function taking the provider. Codex,
--    cut over by 0689, is recorded with committed_at = '-infinity'.
-- 2. Switch rows and core connections before a receipt: no role (runtime or
--    owner-run routine) inserts or enables a cutover row, or inserts a core
--    connection, for a provider without a receipt. Runtime roles never delete
--    a cutover row, and no row changes organization or provider.
-- 3. The organization seed: one provider-neutral seed for every provider with
--    a receipt replaces the Codex seed body (Codex is seeded exactly as 0689
--    seeds it).
-- 4. Provider-checked primary connections in subscription_settings.
-- 5. Operation kinds: `video` added; `model` and `credential_request` admitted
--    for every provider (the unknown-outcome replay fence is already keyed by
--    the provider registry since 0707). `apps` stays Codex-only.
-- 6. The `model.connected` lifecycle fact on core connection insert.
-- 7. Personal authority helpers (0667 placement, 0668 access): 0668's v1
--    legacy-generation branch is replaced; both helpers grant nothing for a
--    provider without a receipt or with a disabled cutover row, and require
--    the exact owner membership.
-- 8. One provider-keyed cutover report relation, with the readiness count of
--    Codex owners holding more than one current personal generation.
SET LOCAL lock_timeout = '5s';

-- 1. Cutover receipts.
DO $receipt_prerequisite$
BEGIN
  IF to_regprocedure('opengeni_private.subscription_codex_cutover_v1_active()') IS NULL THEN
    RAISE EXCEPTION '0711 requires the committed 0689 Codex cutover' USING ERRCODE = '55000';
  END IF;
END
$receipt_prerequisite$;

CREATE TABLE opengeni_private.subscription_provider_cutover_receipts (
  provider text PRIMARY KEY CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  migration text NOT NULL CHECK (migration ~ '^[0-9]{4}_[a-z0-9_]{1,120}\.sql$'),
  -- '-infinity' for a provider cut over before receipts existed (Codex), so
  -- the time-based backstop never treats its existing work as pre-receipt.
  -- Never read as a date by TypeScript: the readiness function answers.
  committed_at timestamptz NOT NULL,
  -- The provider's rotation default in the account-level settings row the
  -- seed below writes for a new organization.
  seed_rotation jsonb NOT NULL CHECK (jsonb_typeof(seed_rotation) = 'object')
);
REVOKE ALL ON TABLE opengeni_private.subscription_provider_cutover_receipts FROM PUBLIC;

DO $receipt_guard$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      -- A receipt is the one-way point of its provider's cutover.
      RAISE EXCEPTION 'subscription provider cutover receipts are append-only'
        USING ERRCODE = '55000';
    END
    $body$
  $ddl$, data_schema);
END
$receipt_guard$;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts()
  FROM PUBLIC;
CREATE TRIGGER subscription_provider_cutover_receipts_append_only
  BEFORE UPDATE OR DELETE ON opengeni_private.subscription_provider_cutover_receipts
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts();
CREATE TRIGGER subscription_provider_cutover_receipts_no_truncate
  BEFORE TRUNCATE ON opengeni_private.subscription_provider_cutover_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_subscription_internal.guard_subscription_provider_cutover_receipts();

INSERT INTO opengeni_private.subscription_provider_cutover_receipts (
  provider, migration, committed_at, seed_rotation
) VALUES ('codex', '0689_subscription_core_codex_cutover.sql', '-infinity', '{"mode":"spread"}');

-- The readiness answer for one provider: true once its cutover committed.
-- Runtime roles call it (startup readiness, RLS policies below); it reveals
-- nothing but the boolean.
DO $receipt_reader$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_provider_cutover_committed(p_provider text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
      SELECT EXISTS (
        SELECT 1 FROM opengeni_private.subscription_provider_cutover_receipts receipt
        WHERE receipt.provider = p_provider
      )
    $body$
  $ddl$, data_schema);
END
$receipt_reader$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_provider_cutover_committed(text) FROM PUBLIC;
DO $receipt_reader_grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_provider_cutover_committed(text)
      TO opengeni_app;
  END IF;
END
$receipt_reader_grant$;

-- 2. Switch rows and core connections before a receipt (finding 1 of 5.3).
-- Restrictive policies bind every role the table's FORCE RLS binds, the owner
-- and owner-run routines included: a later drained cutover inserts its
-- receipt before it moves rows. A row may still be disabled (fail-closed
-- maintenance) whatever its provider.
CREATE POLICY subscription_provider_cutovers_receipt_insert ON subscription_provider_cutovers
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (opengeni_private.subscription_provider_cutover_committed(provider));
CREATE POLICY subscription_provider_cutovers_receipt_update ON subscription_provider_cutovers
  AS RESTRICTIVE FOR UPDATE USING (true)
  WITH CHECK (NOT enabled OR opengeni_private.subscription_provider_cutover_committed(provider));
CREATE POLICY subscription_connections_receipt_insert ON subscription_connections
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (opengeni_private.subscription_provider_cutover_committed(provider));
-- Runtime roles never delete a switch row: without a receipt the row is never
-- usable (operators remove pre-existing ones through the runbook inventory),
-- with one it must stay so no organization returns to the "no row" legacy
-- disposition. Organization deletion still cascades (referential actions are
-- not subject to row security).
DROP POLICY subscription_provider_cutovers_admin_delete ON subscription_provider_cutovers;

-- No cutover row changes organization or provider, whatever its provider
-- (0689 kept only Codex rows fixed). 0689's Codex trigger stays (a subset).
DO $cutover_identity$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      IF NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.account_id IS DISTINCT FROM OLD.account_id
      THEN
        RAISE EXCEPTION 'a subscription cutover row keeps its organization and provider'
          USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$cutover_identity$;
REVOKE ALL ON FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity() FROM PUBLIC;
CREATE TRIGGER subscription_provider_cutovers_identity
  BEFORE UPDATE ON subscription_provider_cutovers
  FOR EACH ROW EXECUTE FUNCTION opengeni_subscription_internal.keep_subscription_cutover_identity();

-- 3. The organization seed, for every provider with a receipt. 0689's seed
-- trigger keeps its name and function name; its body is replaced (two seeds
-- would both insert into the same unique rows). The seed-only insert
-- policies keep the owner, per-organization, enabled-row and
-- organization-level checks and replace `provider = 'codex'` with "this
-- provider has a receipt".
DROP POLICY subscription_provider_cutovers_codex_seed ON subscription_provider_cutovers;
DROP POLICY subscription_settings_codex_seed ON subscription_settings;
DO $cutover_seed$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE POLICY subscription_provider_cutovers_seed ON %1$I.subscription_provider_cutovers
    FOR INSERT WITH CHECK (
      enabled AND opengeni_private.subscription_provider_cutover_committed(provider)
      AND CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_provider_cutovers'::regclass))
      AND current_setting('opengeni.subscription_cutover_seed', true) = account_id::text
    )
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE POLICY subscription_settings_seed ON %1$I.subscription_settings
    FOR INSERT WITH CHECK (
      workspace_id IS NULL
      AND CURRENT_USER = pg_catalog.pg_get_userbyid((SELECT relation.relowner FROM pg_catalog.pg_class relation
        WHERE relation.oid = '%1$I.subscription_settings'::regclass))
      AND current_setting('opengeni.subscription_cutover_seed', true) = account_id::text
    )
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.seed_subscription_codex_cutover()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      previous text := current_setting('opengeni.subscription_cutover_seed', true);
      seeded_rotation jsonb;
    BEGIN
      SELECT jsonb_object_agg(receipt.provider, receipt.seed_rotation) INTO seeded_rotation
      FROM opengeni_private.subscription_provider_cutover_receipts receipt;
      IF seeded_rotation IS NULL THEN RETURN NEW; END IF;
      PERFORM pg_catalog.set_config('opengeni.subscription_cutover_seed', NEW.id::text, true);
      -- A brand-new organization has no rows yet. (ON CONFLICT would need a
      -- SELECT policy for the arbiter and is deliberately not used.)
      INSERT INTO subscription_provider_cutovers (account_id, provider, enabled, updated_by_subject_id)
      SELECT NEW.id, receipt.provider, true, 'service:subscription-core-cutover'
      FROM opengeni_private.subscription_provider_cutover_receipts receipt
      ORDER BY receipt.provider;
      -- The account-level settings row is unique per organization: one row
      -- with the defaults of every provider that has a receipt.
      INSERT INTO subscription_settings (
        account_id, workspace_id, rotation, providers, cross_provider_failover, fallback_order,
        personal_connections_allowed, personal_fallback_allowed, updated_by_subject_id
      ) VALUES (
        NEW.id, NULL, seeded_rotation, '{}'::jsonb, false, '{}'::jsonb,
        true, false, 'service:subscription-core-cutover'
      );
      PERFORM pg_catalog.set_config('opengeni.subscription_cutover_seed', coalesce(previous, ''), true);
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$cutover_seed$;
REVOKE ALL ON FUNCTION opengeni_private.seed_subscription_codex_cutover() FROM PUBLIC;

-- 4. Provider-checked primary connections (finding 4 of 5.3): each provider's
-- primary column can reference only that provider's connection. The constant
-- provider columns are metadata-only additions; older binaries never name
-- them and get the default. A primary that already points at another
-- provider's connection (never valid) is cleared and counted in the report.
ALTER TABLE subscription_settings
  ADD COLUMN codex_primary_provider text NOT NULL DEFAULT 'codex'
    CONSTRAINT subscription_settings_codex_primary_provider_chk CHECK (codex_primary_provider = 'codex'),
  ADD COLUMN claude_primary_provider text NOT NULL DEFAULT 'claude'
    CONSTRAINT subscription_settings_claude_primary_provider_chk CHECK (claude_primary_provider = 'claude'),
  ADD COLUMN xai_primary_provider text NOT NULL DEFAULT 'xai'
    CONSTRAINT subscription_settings_xai_primary_provider_chk CHECK (xai_primary_provider = 'xai');

CREATE TABLE opengeni_private.subscription_cutover_report (
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
  metric text NOT NULL CHECK (length(metric) BETWEEN 1 AND 96),
  account_id uuid,
  legacy_count bigint NOT NULL CHECK (legacy_count >= 0),
  core_count bigint NOT NULL CHECK (core_count >= 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE opengeni_private.subscription_cutover_report FROM PUBLIC;
-- One relation for every provider: the Codex cutover's evidence moves in
-- unchanged (0689's relation stays, read-only, for forensics).
INSERT INTO opengeni_private.subscription_cutover_report (
  provider, metric, account_id, legacy_count, core_count, recorded_at
)
SELECT 'codex', report.metric, report.account_id, report.legacy_count, report.core_count,
  report.recorded_at
FROM opengeni_private.subscription_codex_cutover_report report;

ALTER TABLE subscription_settings NO FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_user_resource_authorities NO FORCE ROW LEVEL SECURITY;
WITH mismatched AS (
  SELECT settings.id, settings.account_id,
    settings.codex_primary_connection_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = settings.account_id
        AND connection.id = settings.codex_primary_connection_id AND connection.provider = 'codex'
    ) AS codex,
    settings.claude_primary_connection_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = settings.account_id
        AND connection.id = settings.claude_primary_connection_id AND connection.provider = 'claude'
    ) AS claude,
    settings.xai_primary_connection_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = settings.account_id
        AND connection.id = settings.xai_primary_connection_id AND connection.provider = 'xai'
    ) AS xai
  FROM subscription_settings settings
), cleared AS (
  UPDATE subscription_settings settings SET
    codex_primary_connection_id = CASE WHEN mismatched.codex THEN NULL
      ELSE settings.codex_primary_connection_id END,
    claude_primary_connection_id = CASE WHEN mismatched.claude THEN NULL
      ELSE settings.claude_primary_connection_id END,
    xai_primary_connection_id = CASE WHEN mismatched.xai THEN NULL
      ELSE settings.xai_primary_connection_id END
  FROM mismatched
  WHERE mismatched.id = settings.id AND (mismatched.codex OR mismatched.claude OR mismatched.xai)
  RETURNING mismatched.account_id, mismatched.codex, mismatched.claude, mismatched.xai
)
INSERT INTO opengeni_private.subscription_cutover_report (
  provider, metric, account_id, legacy_count, core_count
)
SELECT cleared_provider.provider, 'disposition:primary_of_other_provider_cleared',
  cleared.account_id, count(*), 0
FROM cleared
CROSS JOIN LATERAL (VALUES ('codex', cleared.codex), ('claude', cleared.claude),
  ('xai', cleared.xai)) cleared_provider(provider, was_cleared)
WHERE cleared_provider.was_cleared
GROUP BY cleared_provider.provider, cleared.account_id;

-- 8 (readiness count, finding 7 of 5.3): Codex owners whose active,
-- serviceable personal connections carry more than one current authority
-- generation get an empty personal v2 entry on every new acceptance. Count
-- only, per organization plus one total row; the repair is an owner decision.
WITH owners AS (
  SELECT connection.account_id, connection.owner_organization_membership_id
  FROM subscription_connections connection
  JOIN organization_user_resource_authorities authority
    ON authority.id = connection.authority_id
    AND authority.account_id = connection.account_id
    AND authority.organization_membership_id = connection.owner_organization_membership_id
    AND authority.resource_kind = 'subscription_connection'
    AND authority.resource_id = connection.id
    AND authority.generation = connection.authority_generation
    AND authority.status = 'active' AND authority.revoked_at IS NULL
  WHERE connection.provider = 'codex' AND connection.ownership = 'personal'
    AND connection.status = 'active'
  GROUP BY connection.account_id, connection.owner_organization_membership_id
  HAVING count(DISTINCT connection.authority_generation) > 1
)
INSERT INTO opengeni_private.subscription_cutover_report (
  provider, metric, account_id, legacy_count, core_count
)
SELECT 'codex', 'readiness:owners_with_multiple_current_personal_generations',
  owners.account_id, 0, count(*)
FROM owners GROUP BY owners.account_id
UNION ALL
SELECT 'codex', 'readiness:owners_with_multiple_current_personal_generations',
  NULL, 0, (SELECT count(*) FROM owners);
ALTER TABLE organization_user_resource_authorities FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE subscription_settings FORCE ROW LEVEL SECURITY;

ALTER TABLE subscription_settings
  ADD CONSTRAINT subscription_settings_codex_primary_provider_fkey
    FOREIGN KEY (account_id, codex_primary_provider, codex_primary_connection_id)
    REFERENCES subscription_connections(account_id, provider, id)
    ON DELETE SET NULL (codex_primary_connection_id) NOT VALID,
  ADD CONSTRAINT subscription_settings_claude_primary_provider_fkey
    FOREIGN KEY (account_id, claude_primary_provider, claude_primary_connection_id)
    REFERENCES subscription_connections(account_id, provider, id)
    ON DELETE SET NULL (claude_primary_connection_id) NOT VALID,
  ADD CONSTRAINT subscription_settings_xai_primary_provider_fkey
    FOREIGN KEY (account_id, xai_primary_provider, xai_primary_connection_id)
    REFERENCES subscription_connections(account_id, provider, id)
    ON DELETE SET NULL (xai_primary_connection_id) NOT VALID;
ALTER TABLE subscription_settings VALIDATE CONSTRAINT subscription_settings_codex_primary_provider_fkey;
ALTER TABLE subscription_settings VALIDATE CONSTRAINT subscription_settings_claude_primary_provider_fkey;
ALTER TABLE subscription_settings VALIDATE CONSTRAINT subscription_settings_xai_primary_provider_fkey;
-- The provider-checked keys imply the old ones.
ALTER TABLE subscription_settings
  DROP CONSTRAINT subscription_settings_account_id_codex_primary_connection__fkey,
  DROP CONSTRAINT subscription_settings_account_id_claude_primary_connection_fkey,
  DROP CONSTRAINT subscription_settings_account_id_xai_primary_connection_id_fkey;

-- 5. Operation kinds. `video` follows the `image` guard rules (a session is
-- required; personal access needs the exact turn), which the reference guard
-- already applies to every kind outside its explicit sessionless list.
-- `model` and `credential_request` are no longer Codex-only; `apps` is.
ALTER TABLE subscription_operation_leases
  DROP CONSTRAINT subscription_operation_leases_kind_chk,
  ADD CONSTRAINT subscription_operation_leases_kind_chk CHECK (
    operation_kind IN ('image', 'video', 'realtime', 'transcription', 'model',
      'credential_request', 'apps')
    AND (operation_kind <> 'apps' OR provider = 'codex')
  ) NOT VALID;
ALTER TABLE subscription_operation_leases VALIDATE CONSTRAINT subscription_operation_leases_kind_chk;

-- 6. `model.connected` on core connection insert, keyed by provider (the
-- legacy credential tables' triggers stopped covering Codex at 0689). A
-- drained cutover's own inserts set opengeni.subscription_cutover_provider
-- for the move and emit nothing. The attribute names are the legacy ones.
DO $model_connected$
DECLARE definition text; anchor text; replacement text;
BEGIN
  definition := pg_get_functiondef('opengeni_private.capture_product_lifecycle_fact()'::regprocedure);
  anchor := $old$          WHEN 'organization_model_provider_connections' THEN$old$;
  replacement := $new$          WHEN 'subscription_connections' THEN
            SELECT 'model.connected', attribute.value, NEW.connected_by_subject_id,
              NEW.account_id, NULL, NEW.id::text
              INTO v_fact_type, v_attribute, v_subject_id, v_account_id,
                v_workspace_id, v_dedupe_key
            FROM (VALUES ('codex', 'codex'), ('xai', 'supergrok'),
              ('claude', 'claude_subscription')) attribute(provider, value)
            WHERE attribute.provider = NEW.provider;
          WHEN 'organization_model_provider_connections' THEN$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
    RAISE EXCEPTION 'product lifecycle capture source changed';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$model_connected$;
CREATE TRIGGER product_lifecycle_fact_model_connected
  AFTER INSERT ON subscription_connections
  FOR EACH ROW
  WHEN (coalesce(current_setting('opengeni.subscription_cutover_provider', true), '') = '')
  EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- 7. Personal authority helpers. 0668's non-Codex branch compared a legacy
-- generation with a core one and required neither the owner membership nor
-- personalConnectionsAllowed (findings 1 and 5 of 5.3); it is replaced, not
-- generalized. A provider reads its v2 entry only after its receipt and only
-- with an enabled cutover row; otherwise both helpers grant nothing, and
-- until its receipt a provider's personal access is decided only by its v1
-- path (legacy factory tables, which never call these helpers). For Codex
-- (receipt, rows seeded enabled and undeletable) nothing changes.
DO $personal_access$
DECLARE definition text; previous text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.authorize_subscription_personal_access(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure);
  previous := definition;
  definition := replace(definition, $old$      accepted_snapshot jsonb;
$old$,
    '');
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$      codex_core boolean := false;
      codex_cutover_row boolean := false;$old$,
    $new$      provider_core boolean := false;$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$      -- Codex reads its v2 entry only after its own cutover is enabled. A
      -- cutover row that exists but is disabled grants no personal authority
      -- at all: v1 stays authoritative only while no row exists.
      IF p_provider = 'codex' THEN
        SELECT true, coalesce(cutover.enabled, false) INTO codex_cutover_row, codex_core
        FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex';
        codex_cutover_row := coalesce(codex_cutover_row, false);
        codex_core := coalesce(codex_core, false);
      END IF;$old$,
    $new$      -- A provider reads its v2 entry only after its own receipt and with
      -- an enabled cutover row. Without a receipt, without a row, or with a
      -- disabled row this grants nothing.
      IF opengeni_private.subscription_provider_cutover_committed(p_provider) THEN
        SELECT coalesce(cutover.enabled, false) INTO provider_core
        FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider;
        provider_core := coalesce(provider_core, false);
      END IF;$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$      SELECT CASE p_provider
          WHEN 'codex' THEN turn.codex_provider_account_authority_snapshot
          WHEN 'claude' THEN turn.claude_provider_account_authority_snapshot
          WHEN 'xai' THEN turn.xai_provider_account_authority_snapshot
        END,
        turn.subscription_authority, membership.id, connection.authority_generation
      INTO accepted_snapshot, v2_snapshot, owner_membership, connection_generation$old$,
    $new$      SELECT turn.subscription_authority, membership.id, connection.authority_generation
      INTO v2_snapshot, owner_membership, connection_generation$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$        AND (codex_core IS NOT TRUE
          OR session.owner_organization_membership_id = connection.owner_organization_membership_id)$old$,
    $new$        AND session.owner_organization_membership_id = connection.owner_organization_membership_id$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$      IF codex_cutover_row AND NOT codex_core THEN
        authorized := false;
      ELSIF codex_core THEN$old$,
    $new$      IF NOT provider_core THEN
        authorized := false;
      ELSE$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$            WHERE entry->>'provider' = 'codex'$old$,
    $new$            WHERE entry->>'provider' = p_provider$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  previous := definition;
  definition := replace(definition, $old$      ELSE
        -- Unchanged v1 check, including its three-valued NULL semantics.
        authorized := accepted_snapshot IS NOT NULL AND accepted_snapshot->>'scope' = 'user'
          AND accepted_snapshot->>'authorityGeneration' IS NOT DISTINCT FROM (
            SELECT authority_generation::text FROM subscription_connections
            WHERE account_id = p_account_id AND id = p_connection_id
          );
      END IF;$old$,
    $new$      END IF;$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal access source changed';
  END IF;
  IF position('codex' IN definition) > 0 OR position('provider_account_authority_snapshot' IN definition) > 0 THEN
    RAISE EXCEPTION 'subscription personal access still names a provider';
  END IF;
  EXECUTE definition;
END
$personal_access$;

DO $personal_placement$
DECLARE definition text; previous text;
BEGIN
  definition := pg_get_functiondef(
    'opengeni_private.authorize_subscription_personal_placement_access(uuid,uuid,uuid,uuid,text,uuid,bigint,text,text)'::regprocedure);
  previous := definition;
  definition := replace(definition, $old$        OR p_provider NOT IN ('codex', 'claude', 'xai')$old$,
    $new$        OR NOT coalesce(opengeni_private.subscription_provider_cutover_committed(p_provider), false)$new$);
  IF definition = previous THEN
    RAISE EXCEPTION 'subscription personal placement access source changed';
  END IF;
  EXECUTE definition;
END
$personal_placement$;

-- 9. A refresh never changes a credential's format. The provider-neutral
-- persist routines (0707) wrote the encryption envelope's version into
-- `credential_format`, which would overwrite an adapter format such as
-- `claude_setup_token_v1` on the first refresh. Codex stores the envelope
-- version ('v1') as its format, so its rows are unchanged.
DO $refresh_format$
DECLARE definition text; routine text;
  anchor text := $old$credential_format = split_part(p_credential_encrypted, ':', 1),$old$;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'opengeni_private.persist_subscription_core_refresh(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)',
    'opengeni_private.persist_subscription_core_refresh_with_plan(text,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,text)',
    'opengeni_private.persist_subscription_core_connection_refresh(text,uuid,uuid,uuid,bigint,text,timestamptz,timestamptz)'
  ] LOOP
    definition := pg_get_functiondef(routine::regprocedure);
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription core refresh persistence source changed';
    END IF;
    EXECUTE replace(definition, anchor, '');
  END LOOP;
END
$refresh_format$;
