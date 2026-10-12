-- deployment-mode: rolling
-- Per-provider session bindings (D-32 of docs/subscription-accounts.md).
--
-- A session keeps one binding per provider: its explicit choice or its
-- automatic placement for that provider's models. Before the shared core each
-- provider kept its own session pin, so a session pinned to a Codex account
-- that switched to another provider's model kept the Codex pin. One row per
-- session cannot hold that.
--
-- Rolling expand step: the primary key becomes (workspace_id, session_id,
-- provider). The previous binary upserts with ON CONFLICT (workspace_id,
-- session_id), so a unique index on (workspace_id, session_id) stays for the
-- rolling window and keeps that conflict target valid. While it exists a
-- session still holds at most one binding row, exactly as before; today only
-- Codex writes core bindings. The drained cutover of the next provider to
-- join the core drops the index, after its preflight refuses every other
-- runtime login and before it writes any binding of its own. Dropping it is
-- safe only once no previous binary can run at all: only the previous upsert
-- fails (42P10) without the index; the previous binary's binding reads and its
-- Codex pin's UPDATE by (workspace_id, session_id, version) carry no provider
-- and would read or rewrite another provider's row.
--
-- A binding row never changes provider: each provider writes only its own
-- row. The trigger below refuses a provider change from any runtime writer,
-- so a previous binary's upsert (which sets provider = excluded.provider) can
-- never turn one provider's binding into another's. A drained cutover that
-- disables this table's triggers for its bulk move keeps this one enabled
-- (a move never changes a row's provider) or asserts afterwards that no
-- pre-existing row changed provider.
--
-- Existing rows keep every value; only the key changes. The whole lock set is
-- taken first: building the index takes SHARE and replacing the key ACCESS
-- EXCLUSIVE, and upgrading between them would deadlock with a live binding
-- writer (it reads its row FOR UPDATE, then writes it).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE subscription_session_bindings IN ACCESS EXCLUSIVE MODE;

CREATE UNIQUE INDEX subscription_session_bindings_rolling_session_idx
  ON subscription_session_bindings (workspace_id, session_id);
COMMENT ON INDEX subscription_session_bindings_rolling_session_idx IS
  'Rolling window of 0732 only: keeps the previous binary''s ON CONFLICT (workspace_id, session_id) valid. Dropped by the next drained provider cutover.';
ALTER TABLE subscription_session_bindings DROP CONSTRAINT subscription_session_bindings_pkey;
ALTER TABLE subscription_session_bindings
  ADD CONSTRAINT subscription_session_bindings_pkey PRIMARY KEY (workspace_id, session_id, provider);

CREATE FUNCTION opengeni_private.guard_subscription_binding_provider()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'a subscription session binding never changes provider'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_binding_provider() FROM PUBLIC;
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.guard_subscription_binding_provider() TO %I',
      application_role
    );
  END LOOP;
END
$grant_runtime$;

CREATE TRIGGER subscription_session_bindings_provider_fixed
  BEFORE UPDATE OF provider
  ON subscription_session_bindings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_binding_provider();
