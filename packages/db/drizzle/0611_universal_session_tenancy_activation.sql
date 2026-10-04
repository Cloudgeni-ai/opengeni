-- deployment-mode: rolling
-- Retire per-organization session-tenancy activation. Every organization is
-- activated: private ("Only me") sessions, visibility transitions, forks and
-- personal-resource grants no longer require a version-1
-- session_tenancy_activations receipt, and the owner/admin Only-me setting
-- (organization_private_session_settings) now defaults to ENABLED when an
-- organization has no row. Owners/admins may still disable it; an explicit
-- disabled row keeps gating new Only-me chats in shared workspaces.
--
-- No receipts are written and no data is backfilled. The receipt keeps exactly
-- one meaning: opengeni_private.session_tenancy_account_activated (0340) still
-- retires the legacy_user connection and unattributed-writer compatibility
-- lanes only for organizations that already hold one. Organizations without a
-- receipt keep those lanes exactly as before this migration, so no stored
-- authority becomes invisible and no ownership is inferred.
--
-- Rolling: this only widens product predicates and flips a missing-row default.
-- A pre-0611 binary keeps working against the rewritten routines: its own
-- receipt probe (session_tenancy_product_activated) now answers true, its
-- startup interlock probe (session_tenancy_any_product_activation) answers
-- false regardless of the retired environment switch, and every routine keeps
-- its signature, owner, ACL, SECURITY DEFINER and search_path. No table is
-- locked or rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- Remove the receipt prerequisite from every runtime predicate and default the
-- Only-me setting to enabled. Each rewrite replaces one exact, reviewed
-- fragment of the live definition; a changed shape aborts instead of silently
-- leaving a receipt gate behind. Owner, grants, SECURITY DEFINER and
-- search_path are preserved by CREATE OR REPLACE of the catalog's own
-- definition.
DO $universal_session_tenancy_predicates$
DECLARE
  data_schema text := pg_catalog.current_schema();
  target regprocedure;
  definition text;
  rewrite record;
  occurrences integer;
  -- Fragments below are routine SOURCE text matched against
  -- pg_get_functiondef, never queries: this block reads only the catalog.
  -- The table names are spliced in so the source is not mistaken for a
  -- migration-time row read of a FORCE-RLS table.
  receipts constant text := 'session_tenancy_activations';
  settings constant text := 'organization_private_session_settings';
  receipt_gate constant text :=
    E'  IF NOT EXISTS (\n'
    || E'    SELECT 1 FROM ' || receipts || E' activation\n'
    || E'    WHERE activation.account_id = p_account_id AND activation.activation_version = 1\n'
    || E'  ) THEN\n'
    || E'    RAISE EXCEPTION ''session tenancy product is not activated'' USING ERRCODE = ''42501'';\n'
    || E'  END IF;\n';
  receipt_gate_removed constant text :=
    E'  -- 0611: every organization is session-tenancy activated.\n';
  setting_receipt_gate constant text :=
    E'  IF p_enabled AND NOT session_tenancy_product_activated(p_account_id, 1) THEN\n'
    || E'    RAISE EXCEPTION ''session tenancy product surface is not available for this organization'' USING ERRCODE = ''55000'';\n'
    || E'  END IF;\n';
BEGIN
  FOR rewrite IN
    SELECT * FROM (VALUES
      (1, pg_catalog.format('%I.session_tenancy_product_activated(uuid,integer)', data_schema),
        E'    AND EXISTS (\n'
          || E'    SELECT 1 FROM ' || receipts || E' activation\n'
          || E'    WHERE activation.account_id = p_account_id\n'
          || E'      AND activation.activation_version = p_activation_version\n'
          || E'  )',
        E'    AND p_account_id IS NOT NULL\n'
          || E'    AND p_activation_version IS NOT DISTINCT FROM 1'),
      -- The value-free startup interlock is retired with the deployment switch.
      -- Answering false keeps every earlier binary startable regardless of the
      -- removed OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED value.
      (3, pg_catalog.format('%I.session_tenancy_any_product_activation()', data_schema),
        E'  SELECT EXISTS (\n'
          || E'    SELECT 1 FROM ' || receipts || E'\n'
          || E'  ) INTO activated;',
        E'  activated := false;'),
      (4, pg_catalog.format(
          '%I.list_self_user_resource_authorities(uuid,uuid,text,uuid,integer)', data_schema),
        receipt_gate, receipt_gate_removed),
      (5, pg_catalog.format(
          '%I.issue_self_user_resource_grant(uuid,uuid,uuid,text,text,text,uuid,integer,boolean)',
          data_schema),
        receipt_gate, receipt_gate_removed),
      (6, pg_catalog.format('%I.revoke_self_user_resource_grant(uuid,uuid,uuid)', data_schema),
        receipt_gate, receipt_gate_removed),
      (7, pg_catalog.format(
          '%I.accept_turn_personal_resource_attachment(uuid,uuid,uuid,uuid,text,integer,boolean,integer)',
          data_schema),
        receipt_gate, receipt_gate_removed),
      -- Only-me chats default to enabled: only an explicit disabled row gates.
      (8, pg_catalog.format('%I.organization_private_sessions_enabled(uuid)', data_schema),
        E'    AND session_tenancy_product_activated(p_account_id, 1)\n'
          || E'    AND EXISTS (\n'
          || E'      SELECT 1 FROM ' || settings || E' setting\n'
          || E'      WHERE setting.account_id = p_account_id AND setting.enabled\n'
          || E'    )',
        E'    AND NOT EXISTS (\n'
          || E'      SELECT 1 FROM ' || settings || E' setting\n'
          || E'      WHERE setting.account_id = p_account_id AND NOT setting.enabled\n'
          || E'    )'),
      (9, pg_catalog.format(
          '%I.get_organization_private_session_settings(uuid,text)', data_schema),
        E'    ''enabled'', coalesce(setting.enabled, false),\n',
        E'    ''enabled'', coalesce(setting.enabled, true),\n'),
      (10, pg_catalog.format(
          '%I.update_organization_private_session_settings(uuid,text,boolean,bigint,uuid)',
          data_schema),
        setting_receipt_gate, ''),
      (11, pg_catalog.format(
          '%I.update_organization_private_session_settings(uuid,text,boolean,bigint,uuid)',
          data_schema),
        E'  did_change := coalesce(setting.enabled, false) IS DISTINCT FROM p_enabled;\n',
        E'  did_change := coalesce(setting.enabled, true) IS DISTINCT FROM p_enabled;\n')
    ) AS rewrites(ordinal, signature, old_fragment, new_fragment)
    ORDER BY ordinal
  LOOP
    target := pg_catalog.to_regprocedure(rewrite.signature);
    IF target IS NULL THEN
      RAISE EXCEPTION 'universal session tenancy predicate is missing: %', rewrite.signature
        USING ERRCODE = '55000';
    END IF;
    definition := pg_catalog.pg_get_functiondef(target);
    occurrences := (
      pg_catalog.length(definition)
        - pg_catalog.length(pg_catalog.replace(definition, rewrite.old_fragment, ''))
    ) / pg_catalog.length(rewrite.old_fragment);
    IF occurrences <> 1 THEN
      RAISE EXCEPTION 'universal session tenancy predicate shape changed: % (% matches)',
        rewrite.signature, occurrences USING ERRCODE = '55000';
    END IF;
    EXECUTE pg_catalog.replace(definition, rewrite.old_fragment, rewrite.new_fragment);
  END LOOP;

  -- Fail closed if any other routine still consults the receipt table. Only
  -- the retained, now-dormant receipt writers (operator, greenfield and
  -- additional-organization activation, plus the operator preference
  -- enabler's lock) and the private legacy-lane retirement predicate may.
  -- That predicate is not a product prerequisite: it closes the legacy_user
  -- connection and unattributed-writer compatibility lanes only for an
  -- organization that already holds a receipt.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname IN (data_schema, 'opengeni_private')
      AND routine.prosrc LIKE '%session_tenancy_activations%'
      AND routine.proname NOT IN (
        'activate_session_tenancy_product',
        'activate_greenfield_session_tenancy_from_setup',
        'activate_session_tenancy_from_additional_organization',
        'enable_organization_private_sessions_from_activation',
        'session_tenancy_account_activated'
      )
  ) THEN
    RAISE EXCEPTION 'a runtime routine still requires a session tenancy activation receipt'
      USING ERRCODE = '55000';
  END IF;
END
$universal_session_tenancy_predicates$;

COMMENT ON FUNCTION session_tenancy_product_activated(uuid, integer) IS
  'Universal since 0611: true for the transaction''s own organization at activation version 1. No per-organization receipt is required.';
COMMENT ON FUNCTION opengeni_private.session_tenancy_account_activated(uuid) IS
  'Legacy-lane retirement predicate (0340): true when the transaction''s own organization holds a receipt. Since 0611 it gates no product surface; it only closes the legacy_user connection and unattributed-writer lanes.';
COMMENT ON FUNCTION session_tenancy_any_product_activation() IS
  'Retired by 0611 with OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED. Always false so no binary enforces the removed startup interlock.';
