-- deployment-mode: rolling
-- Seed per-task usage-limit counters once per INSERT statement instead of once
-- per inserted row.
--
-- The row trigger opened and closed the transaction-scoped capability for
-- every new root. Every reopen in the same transaction reuses one capability
-- key, so each insert had to step over all earlier dead versions of that key:
-- a multi-row insert of N roots cost O(N^2) (5,000 roots took seconds). The
-- statement trigger reads the statement's inserted rows, opens one capability
-- per tenant, seeds all of that tenant's new roots in one insert and closes
-- the capability again. Single-row inserts behave exactly as before; AFTER ROW
-- triggers also fired at the end of the statement, so nothing in the
-- inserting statement could observe a counter earlier than it does now.
--
-- Rolling-safe: the function keeps its name, signature, owner, grants and
-- pinned search path, and the trigger is replaced inside this transaction, so
-- every session insert is seeded by exactly one of the two forms.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE OR REPLACE FUNCTION seed_session_usage_limit_root()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
DECLARE tenant record; opened integer;
BEGIN
  FOR tenant IN
    SELECT DISTINCT s.account_id, s.workspace_id FROM inserted_sessions s
    WHERE s.id = s.root_session_id
  LOOP
    INSERT INTO opengeni_private.session_usage_limit_capabilities VALUES
      (pg_backend_pid(),pg_current_xact_id(),TG_TABLE_SCHEMA,tenant.account_id,tenant.workspace_id)
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS opened = ROW_COUNT;
    INSERT INTO opengeni_private.session_usage_limit_roots(account_id,workspace_id,root_session_id,history_state)
      SELECT s.account_id, s.workspace_id, s.id, 'complete' FROM inserted_sessions s
      WHERE s.id = s.root_session_id
        AND s.account_id = tenant.account_id AND s.workspace_id = tenant.workspace_id
      ON CONFLICT (workspace_id, root_session_id) DO NOTHING;
    IF opened = 1 THEN
      DELETE FROM opengeni_private.session_usage_limit_capabilities
        WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id_if_assigned()
          AND data_schema=TG_TABLE_SCHEMA AND account_id=tenant.account_id
          AND workspace_id=tenant.workspace_id;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER session_usage_limit_root_seed ON sessions;
CREATE TRIGGER session_usage_limit_root_seed AFTER INSERT ON sessions
  REFERENCING NEW TABLE AS inserted_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION seed_session_usage_limit_root();

DO $acl$
DECLARE target_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION %I.seed_session_usage_limit_root() SET search_path=pg_catalog,%I,pg_temp',
    target_schema, target_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %I.seed_session_usage_limit_root() FROM PUBLIC', target_schema);
END $acl$;
