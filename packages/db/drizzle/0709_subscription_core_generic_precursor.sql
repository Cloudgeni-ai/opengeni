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
    RAISE EXCEPTION '0709 requires the committed 0689 Codex cutover' USING ERRCODE = '55000';
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
