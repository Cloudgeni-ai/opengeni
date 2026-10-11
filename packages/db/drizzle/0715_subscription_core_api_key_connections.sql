-- deployment-mode: rolling
-- API-key connections on the shared subscription core (design
-- docs/design/subscription-core-2026-10-07.md, 2.1, 5.1.2 and "M4
-- implementation plan", step F). The neutral routines from 0707 managed only
-- rows with `kind = 'subscription'`, so a provider whose credential is a
-- static API key (an API-key connector, whose rows have `kind = 'api_key'`
-- in the same table) could not use the core's credential seams, health
-- (quarantine and recovery), v2 accepted authority or the personal writers.
-- Which kind a provider's rows have is now registry data, never a branch on
-- a provider name.
--
-- Rolling: nothing existing changes meaning. The one registered provider
-- keeps `connection_kind = 'subscription'`, so every rewritten routine
-- selects exactly the rows it selected before, with the same arguments and
-- results for older binaries. The provider-named routines are untouched. No
-- provider row, table or route is added.
--
-- 1. `opengeni_private.subscription_core_providers.connection_kind`
--    (`subscription` | `api_key`, default `subscription`; a constant default,
--    so no table rewrite). It is immutable once registered: flipping it would
--    hand one kind's rows to routines that were admitting the other.
-- 2. `opengeni_private.subscription_core_connection_kind(provider)`: the
--    registered kind, or NULL for an unregistered provider (which equals no
--    row, so the routines keep failing closed). The neutral routines are
--    SECURITY DEFINER and call it as their owner. It is not SECURITY DEFINER
--    and the runtime role cannot read the registry, so only owner-run callers
--    get an answer; every configured application role still holds EXECUTE on
--    it and on the new trigger function, because an older binary's runtime
--    posture requires EXECUTE on every private routine it does not know (as
--    0707 did for its registry trigger, granted to configured roles as in
--    0712). PUBLIC holds none.
-- 3. The sixteen neutral routines that compared (or, in the personal
--    connect, inserted) the literal kind use the registered kind instead:
--    fourteen from 0707, the organization reach setter (0713, redefined by
--    0714) and 0714's reach allocator setter.
--    Each is rewritten from its live definition by anchored replacement with
--    exact counts (the pattern 0707 used for the disconnect-admission
--    trigger), so the owner, grants, volatility, SECURITY DEFINER and search
--    path are preserved, and a definition that drifted fails the migration
--    instead of being overwritten. Afterwards no neutral routine names a
--    connection kind.
-- 4. Two personal reads that never named a kind gain the registered-kind
--    filter the same way: the target lookup of
--    `manage_subscription_core_personal` (rename, allocator, primary, extra
--    credits and the Personal-workspace resolve) and the authority-generation
--    read of `connect_subscription_core_personal`. A provider's personal
--    management and its new personal connections' authority generation then
--    see only rows of its kind, like every other neutral read.
SET LOCAL lock_timeout = '5s';

-- 1. The registered connection kind.
ALTER TABLE opengeni_private.subscription_core_providers
  ADD COLUMN connection_kind text NOT NULL DEFAULT 'subscription'
    CONSTRAINT subscription_core_providers_connection_kind_chk
      CHECK (connection_kind IN ('subscription', 'api_key'));

CREATE FUNCTION opengeni_private.guard_subscription_provider_connection_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.connection_kind IS DISTINCT FROM OLD.connection_kind THEN
    RAISE EXCEPTION 'subscription core provider connection kind is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_provider_connection_kind() FROM PUBLIC;
CREATE TRIGGER subscription_core_providers_connection_kind_immutable
  BEFORE UPDATE ON opengeni_private.subscription_core_providers
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_provider_connection_kind();

-- 2. The kind lookup the neutral routines use.
CREATE FUNCTION opengeni_private.subscription_core_connection_kind(p_provider text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT registry.connection_kind
  FROM opengeni_private.subscription_core_providers registry
  WHERE registry.provider = p_provider
$body$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_core_connection_kind(text) FROM PUBLIC;
-- Every configured application role (not only the default name) holds
-- EXECUTE before provision-roles, so an older binary's posture check stays
-- clean under a custom role too (0706's and 0712's pattern).
DO $grant_runtime$
DECLARE
  application_role text;
BEGIN
  FOR application_role IN
    SELECT role_value.rolname
    FROM pg_catalog.jsonb_array_elements_text(
      coalesce(nullif(current_setting('opengeni.migration_application_roles', true), ''), '[]')::jsonb
    ) configured(value)
    JOIN pg_catalog.pg_roles role_value ON role_value.rolname = configured.value
    UNION SELECT 'opengeni_app'
      WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'opengeni_app')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.subscription_core_connection_kind(text) TO %I',
      application_role
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION opengeni_private.guard_subscription_provider_connection_kind() TO %I',
      application_role
    );
  END LOOP;
END
$grant_runtime$;

-- 3. The neutral routines read the registered kind. Every one names its
-- provider `p_provider`; the counts are those of the live definitions (0707's,
-- and 0714's for the two reach setters).
DO $connection_kind$
DECLARE
  routine text;
  filters integer;
  inserts integer;
  definition text;
  filter_anchor constant text := $a$kind = 'subscription'$a$;
  filter_replacement constant text :=
    $r$kind = opengeni_private.subscription_core_connection_kind(p_provider)$r$;
  insert_anchor constant text := $a$p_provider, 'subscription', p_provider_account_id$a$;
  insert_replacement constant text :=
    $r$p_provider, opengeni_private.subscription_core_connection_kind(p_provider), p_provider_account_id$r$;
BEGIN
  FOR routine, filters, inserts IN VALUES
    ('opengeni_subscription_internal.subscription_core_connection_target(text, uuid, uuid, uuid, uuid, uuid, text, bigint)', 1, 0),
    ('opengeni_private.begin_subscription_core_refresh(text, uuid, uuid, uuid, uuid, text, text, uuid, text, bigint)', 1, 0),
    ('opengeni_private.persist_subscription_core_refresh(text, uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone)', 1, 0),
    ('opengeni_private.persist_subscription_core_refresh_with_plan(text, uuid, uuid, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone, text)', 1, 0),
    ('opengeni_private.fail_subscription_core_refresh(text, uuid, uuid, uuid, uuid, uuid, bigint, text)', 1, 0),
    ('opengeni_private.quarantine_subscription_core_connection(text, uuid, uuid, uuid, uuid, uuid, text, bigint, bigint, text, text, timestamp with time zone)', 1, 0),
    ('opengeni_private.recover_subscription_core_connection_health(text, uuid, uuid, uuid, uuid)', 1, 0),
    ('opengeni_private.subscription_core_acceptance_authority_v2(text, uuid, uuid, uuid, text)', 1, 0),
    ('opengeni_private.subscription_core_task_authority_v2(text, uuid, uuid, uuid, text)', 1, 0),
    ('opengeni_private.persist_subscription_core_connection_refresh(text, uuid, uuid, uuid, bigint, text, timestamp with time zone, timestamp with time zone)', 1, 0),
    ('opengeni_private.fail_subscription_core_connection_refresh(text, uuid, uuid, uuid, bigint, text)', 1, 0),
    ('opengeni_private.connect_subscription_core_personal(text, uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text)', 2, 1),
    ('opengeni_private.disconnect_subscription_core_connection(text, uuid, uuid, text, uuid)', 1, 0),
    ('opengeni_private.subscription_core_personal_connections(text, uuid, uuid, text)', 1, 0),
    ('opengeni_private.set_subscription_core_reach(text, uuid, uuid, boolean, boolean)', 1, 0),
    ('opengeni_private.set_subscription_core_reach_allocator(text, uuid, uuid, boolean)', 1, 0)
  LOOP
    definition := pg_catalog.pg_get_functiondef(routine::regprocedure);
    IF (length(definition) - length(replace(definition, filter_anchor, '')))
        <> filters * length(filter_anchor)
      OR (length(definition) - length(replace(definition, insert_anchor, '')))
        <> inserts * length(insert_anchor)
    THEN
      RAISE EXCEPTION 'subscription core routine % source changed', routine;
    END IF;
    definition := replace(replace(definition, insert_anchor, insert_replacement),
      filter_anchor, filter_replacement);
    IF position($q$'subscription'$q$ IN definition) <> 0
      OR position($q$'api_key'$q$ IN definition) <> 0
    THEN
      RAISE EXCEPTION 'subscription core routine % still names a connection kind', routine;
    END IF;
    EXECUTE definition;
  END LOOP;
  -- No neutral routine (including any added since 0707) names a kind.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc procedure
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname IN ('opengeni_private', 'opengeni_subscription_internal')
      AND procedure.proname LIKE '%subscription\_core%' AND procedure.prokind = 'f'
      AND (position($q$'subscription'$q$ IN procedure.prosrc) > 0
        OR position($q$'api_key'$q$ IN procedure.prosrc) > 0)
  ) THEN
    RAISE EXCEPTION 'a neutral subscription-core routine still names a connection kind';
  END IF;
END
$connection_kind$;

-- 4. The two personal reads that did not name a kind.
DO $personal_kind$
DECLARE
  routine text;
  anchor text;
  replacement text;
  definition text;
BEGIN
  FOR routine, anchor, replacement IN VALUES
    ('opengeni_private.manage_subscription_core_personal(text, uuid, uuid, text, uuid, text, text, boolean, integer)',
     $a$AND connection.provider = p_provider AND connection.ownership = 'personal'$a$,
     $r$AND connection.provider = p_provider
        AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
        AND connection.ownership = 'personal'$r$),
    ('opengeni_private.connect_subscription_core_personal(text, uuid, uuid, text, text, text, text, text, jsonb, timestamp with time zone, timestamp with time zone, text, text, text)',
     $a$connection.provider = p_provider
        AND connection.ownership = 'personal'$a$,
     $r$connection.provider = p_provider
        AND connection.kind = opengeni_private.subscription_core_connection_kind(p_provider)
        AND connection.ownership = 'personal'$r$)
  LOOP
    definition := pg_catalog.pg_get_functiondef(routine::regprocedure);
    IF (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) THEN
      RAISE EXCEPTION 'subscription core routine % source changed', routine;
    END IF;
    EXECUTE replace(definition, anchor, replacement);
  END LOOP;
END
$personal_kind$;
