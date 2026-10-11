-- deployment-mode: rolling
-- Cache-aware stickiness on the shared subscription core (design
-- docs/design/subscription-core-2026-10-07.md, 6.1; contract SUB-STICK-02 to
-- SUB-STICK-04). A session binding keeps its account while the prompt cache
-- is warm, and `last_model_call_at` is the clock placement measures warmth
-- from. That clock belongs to the account, model and choice it was measured
-- on: a cache written on one account says nothing about another.
--
-- Before this migration a writer that moved a binding to another account
-- (placement after a forced switch, a person's pin) carried the previous
-- account's clock, so the new account counted as warm although nothing had
-- run on it. This trigger starts the clock cold instead: when an update
-- changes the connection, provider, model or choice of a binding and does not
-- state a new clock, `last_model_call_at` becomes NULL (cold). A writer that
-- states a clock (a model call it records on the new account) keeps it.
-- Changing the choice also starts cold, so removing a pin re-runs normal
-- selection at the next turn (a pin change is a re-selection point).
--
-- Rolling: no table or column changes. Older binaries write the same columns;
-- they only stop carrying a stale clock across a switch, which can only
-- shorten how long a session stays on an account it never used. No row is
-- rewritten.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION opengeni_private.reset_subscription_binding_cache_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF (NEW.connection_id IS DISTINCT FROM OLD.connection_id
      OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.model_id IS DISTINCT FROM OLD.model_id
      OR NEW.choice IS DISTINCT FROM OLD.choice)
    AND NEW.last_model_call_at IS NOT DISTINCT FROM OLD.last_model_call_at THEN
    NEW.last_model_call_at := NULL;
  END IF;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.reset_subscription_binding_cache_clock() FROM PUBLIC;
-- Every configured application role (not only the default name) holds
-- EXECUTE before provision-roles, so an older binary's posture check stays
-- clean under a custom role too (0715's pattern).
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
      'GRANT EXECUTE ON FUNCTION opengeni_private.reset_subscription_binding_cache_clock() TO %I',
      application_role
    );
  END LOOP;
END
$grant_runtime$;

CREATE TRIGGER subscription_session_bindings_cache_clock
  BEFORE UPDATE OF connection_id, provider, model_id, choice
  ON subscription_session_bindings
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.reset_subscription_binding_cache_clock();
