-- deployment-mode: rolling
-- The v2 accepted-authority writers see the owner's personal connections
-- under FORCE row security (design docs/design/subscription-core-2026-10-07.md,
-- "Findings in earlier merged work").
--
-- subscription_core_acceptance_authority_v2, subscription_core_task_authority_v2
-- and their Codex forms (0669, 0688, 0707) run as the migration owner and, to
-- freeze an owner's personal entry, count the generations of the owner's
-- personal connections holding only an account `lifecycle` capability. No
-- policy exposes a personal subscription_connections row to the owner for that
-- capability (personal rows are visible for a per-connection `personal_access`
-- or `binding_access` capability, or to the owner-only membership-lifecycle
-- read), so under a migration owner without BYPASSRLS (the documented posture)
-- the count was always empty and every acceptance froze the empty value: an
-- owner's personal Codex account was never frozen into the turns of their
-- private session or their scheduled tasks. Earlier tests ran the writers on
-- superuser-owned databases.
--
-- Each writer now counts through the owner-only membership-lifecycle read: the
-- transaction-local marker is set immediately before the count and restored
-- to the caller's value right after it. Nothing else in the writers changes.
--
-- Acts on deploy, for Codex (the only provider whose writers are enabled):
-- a new acceptance by an owner with exactly one current personal Codex
-- generation freezes the personal entry the contract defines, as it already
-- did under an owner with BYPASSRLS. Values already frozen are not rewritten.
-- Every patch is an anchored replacement of the live definition; each anchor
-- must occur exactly once.
SET LOCAL lock_timeout = '5s';

DO $personal_acceptance_reads$
DECLARE definition text; routine regprocedure; patch text[];
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'opengeni_private.subscription_codex_acceptance_authority_v2(uuid,uuid,uuid,text)',
    'opengeni_private.subscription_codex_task_authority_v2(uuid,uuid,uuid,text)',
    'opengeni_private.subscription_core_acceptance_authority_v2(text,uuid,uuid,uuid,text)',
    'opengeni_private.subscription_core_task_authority_v2(text,uuid,uuid,uuid,text)'
  ]::regprocedure[] LOOP
    definition := pg_get_functiondef(routine);
    FOREACH patch SLICE 1 IN ARRAY ARRAY[
      ARRAY[$old$      minted_lifecycle boolean := false;
$old$, $new$      minted_lifecycle boolean := false;
      prior_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
$new$],
      ARRAY[$old$        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
$old$, $new$        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
$new$],
      ARRAY[$old$          AND authority.status = 'active' AND authority.revoked_at IS NULL;
      END IF;
$old$, $new$          AND authority.status = 'active' AND authority.revoked_at IS NULL;
        PERFORM pg_catalog.set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(prior_lifecycle, ''), true);
      END IF;
$new$]
    ] LOOP
      IF length(definition) - length(replace(definition, patch[1], '')) <> length(patch[1]) THEN
        RAISE EXCEPTION '% anchor changed: %', routine, left(patch[1], 80)
          USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, patch[1], patch[2]);
    END LOOP;
    EXECUTE definition;
  END LOOP;
END
$personal_acceptance_reads$;
