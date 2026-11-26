-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: the one-time backfill aggregates the ledger once (about 300k rows in production) inside the CREATE TRIGGER lock window, so it is exact; a batched backfill could miss rows inserted between batches.
-- Per-account ledger totals, so a balance read no longer sums the account's
-- whole credit ledger.
--
-- readBillingBalance (packages/db/src/credit-balances.ts) summed every
-- credit_ledger_entries row of the account on every call: the balance, and
-- what API work other than own-key fees has spent. Every model call, turn,
-- voice and web search admission reads the balance, and the sum grew with the
-- account's ledger (130k rows and 119 ms for the largest production account).
--
-- credit_ledger_account_totals keeps those two sums per account, maintained by
-- statement-level triggers on the ledger's inserts, updates and deletes, in
-- the same transaction as the ledger change. A read in any snapshot therefore
-- sees totals exactly equal to the sums over the ledger rows it sees. An
-- account with no row has no ledger rows (totals 0).
--
-- Before it changes an account's totals the trigger takes that account's
-- credit lock, pg_advisory_xact_lock(hashtext(account)), as the plan refund
-- trigger already does, in sorted account order. Ledger writers already hold
-- it (re-entrant), so they wait for nothing new; a writer that does not is
-- serialized per account at its ledger write, and the totals row lock always
-- nests inside the credit lock, never the other way round.
--
-- The trigger function is SECURITY INVOKER: a writer updates totals under the
-- same tenant context that let it write the ledger (the ledger's only write
-- policy is account scoped; the totals policy is the same account check).
-- Foreign-key actions (an account or workspace deletion) run without row
-- security, as for the ledger. A workspace deletion only clears workspace_id,
-- which changes no total; an account deletion removes the totals row through
-- its own foreign key.
--
-- Created and backfilled in this transaction: CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on the ledger, which waits for in-flight ledger writes and holds
-- off new ones until commit, so the backfill sees every row and no row is
-- counted twice. The backfill reads through the owner-only
-- lifecycle_backfill_read capability, so the ledger keeps FORCE RLS and its
-- readers are never blocked.
--
-- Rolling: a new table (FORCE RLS, runtime SELECT, INSERT and UPDATE), a new
-- owner-only invoker trigger function and triggers. The previous release
-- still sums the ledger and never reads the table; its ledger writes keep the
-- totals current through the triggers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE credit_ledger_account_totals (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  -- sum(amount_micros) over the account's ledger.
  balance_micros numeric NOT NULL DEFAULT 0,
  -- sum(-amount_micros) over its API rows other than own-key fees
  -- (usage_origin = 'api' and type <> 'byok_platform_fee').
  api_spent_micros numeric NOT NULL DEFAULT 0
);
COMMENT ON TABLE credit_ledger_account_totals IS
  'Per-account sums over credit_ledger_entries, kept exact by statement triggers (1576).';

DO $credit_ledger_account_totals$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.maintain_credit_ledger_account_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE changed uuid; changed_ids uuid[]; changed_balances numeric[]; changed_api_spent numeric[];
    BEGIN
      IF TG_OP = 'INSERT' THEN
        FOR changed IN SELECT DISTINCT added.account_id FROM added ORDER BY 1 LOOP
          PERFORM pg_advisory_xact_lock(hashtext(changed::text));
        END LOOP;
        INSERT INTO %1$I.credit_ledger_account_totals AS total (account_id, balance_micros, api_spent_micros)
        SELECT added.account_id, sum(added.amount_micros),
          coalesce(sum(-added.amount_micros) FILTER (WHERE added.usage_origin = 'api'
            AND added.type <> 'byok_platform_fee'), 0)
        FROM added GROUP BY added.account_id ORDER BY added.account_id
        ON CONFLICT (account_id) DO UPDATE
          SET balance_micros = total.balance_micros + excluded.balance_micros,
            api_spent_micros = total.api_spent_micros + excluded.api_spent_micros;
      ELSIF TG_OP = 'DELETE' THEN
        FOR changed IN SELECT DISTINCT removed.account_id FROM removed ORDER BY 1 LOOP
          PERFORM pg_advisory_xact_lock(hashtext(changed::text));
        END LOOP;
        UPDATE %1$I.credit_ledger_account_totals total
          SET balance_micros = total.balance_micros - delta.balance,
            api_spent_micros = total.api_spent_micros - delta.api_spent
        FROM (SELECT removed.account_id, sum(removed.amount_micros) AS balance,
            coalesce(sum(-removed.amount_micros) FILTER (WHERE removed.usage_origin = 'api'
              AND removed.type <> 'byok_platform_fee'), 0) AS api_spent
          FROM removed GROUP BY removed.account_id ORDER BY removed.account_id) delta
        WHERE total.account_id = delta.account_id;
      ELSE
        -- Only rows whose amount, origin, type or account changed move a
        -- total; a cleared workspace_id or a metadata change takes no lock
        -- and writes nothing.
        SELECT array_agg(delta.account_id ORDER BY delta.account_id),
          array_agg(delta.balance ORDER BY delta.account_id),
          array_agg(delta.api_spent ORDER BY delta.account_id)
        INTO changed_ids, changed_balances, changed_api_spent
        FROM (SELECT change.account_id, sum(change.balance) AS balance, sum(change.api_spent) AS api_spent
          FROM (
            SELECT added.account_id, added.amount_micros::numeric AS balance,
              CASE WHEN added.usage_origin = 'api' AND added.type <> 'byok_platform_fee'
                THEN -added.amount_micros::numeric ELSE 0 END AS api_spent
            FROM added
            UNION ALL
            SELECT removed.account_id, -removed.amount_micros::numeric,
              CASE WHEN removed.usage_origin = 'api' AND removed.type <> 'byok_platform_fee'
                THEN removed.amount_micros::numeric ELSE 0 END
            FROM removed
          ) change
          GROUP BY change.account_id
          HAVING sum(change.balance) <> 0 OR sum(change.api_spent) <> 0) delta;
        IF changed_ids IS NULL THEN RETURN NULL; END IF;
        FOREACH changed IN ARRAY changed_ids LOOP
          PERFORM pg_advisory_xact_lock(hashtext(changed::text));
        END LOOP;
        INSERT INTO %1$I.credit_ledger_account_totals AS total (account_id, balance_micros, api_spent_micros)
        SELECT delta.account_id, delta.balance, delta.api_spent
        FROM unnest(changed_ids, changed_balances, changed_api_spent) AS delta(account_id, balance, api_spent)
        ORDER BY delta.account_id
        ON CONFLICT (account_id) DO UPDATE
          SET balance_micros = total.balance_micros + excluded.balance_micros,
            api_spent_micros = total.api_spent_micros + excluded.api_spent_micros;
      END IF;
      RETURN NULL;
    END $body$;
  $create$, data_schema);
END $credit_ledger_account_totals$;
REVOKE ALL ON FUNCTION opengeni_private.maintain_credit_ledger_account_totals() FROM PUBLIC;

-- PostgreSQL allows transition tables on single-event triggers only.
CREATE TRIGGER credit_ledger_account_totals_insert AFTER INSERT ON credit_ledger_entries
  REFERENCING NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintain_credit_ledger_account_totals();
CREATE TRIGGER credit_ledger_account_totals_update AFTER UPDATE ON credit_ledger_entries
  REFERENCING OLD TABLE AS removed NEW TABLE AS added
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintain_credit_ledger_account_totals();
CREATE TRIGGER credit_ledger_account_totals_delete AFTER DELETE ON credit_ledger_entries
  REFERENCING OLD TABLE AS removed
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.maintain_credit_ledger_account_totals();

-- The backfill, under the trigger lock taken above. The owner reads the whole
-- ledger through its transaction-scoped lifecycle backfill capability; the new
-- table gets row security only after it is filled.
INSERT INTO opengeni_private.lifecycle_backfill_read_capabilities (backend_pid, transaction_id)
VALUES (pg_backend_pid(), pg_current_xact_id());
DO $credit_ledger_account_totals_capability$
BEGIN
  IF NOT opengeni_private.lifecycle_backfill_read_active() THEN
    RAISE EXCEPTION 'credit ledger totals backfill cannot read the ledger';
  END IF;
END $credit_ledger_account_totals_capability$;
INSERT INTO credit_ledger_account_totals (account_id, balance_micros, api_spent_micros)
SELECT entry.account_id, sum(entry.amount_micros),
  coalesce(sum(-entry.amount_micros) FILTER (WHERE entry.usage_origin = 'api'
    AND entry.type <> 'byok_platform_fee'), 0)
FROM credit_ledger_entries entry
GROUP BY entry.account_id;
DELETE FROM opengeni_private.lifecycle_backfill_read_capabilities
WHERE backend_pid = pg_backend_pid() AND transaction_id = pg_current_xact_id();

ALTER TABLE credit_ledger_account_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_account_totals FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_account_totals_account_isolation ON credit_ledger_account_totals
  USING (account_id = opengeni_private.current_account_id())
  WITH CHECK (account_id = opengeni_private.current_account_id());
REVOKE ALL ON TABLE credit_ledger_account_totals FROM PUBLIC;

-- Every configured application role, as provisioning does.
DO $credit_ledger_account_totals_grant$
DECLARE application_role text;
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
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE credit_ledger_account_totals FROM %I', application_role);
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE ON TABLE credit_ledger_account_totals TO %I', application_role);
  END LOOP;
END $credit_ledger_account_totals_grant$;

-- The per-account balance gauge (every ~28 s) reads the totals instead of
-- summing the whole ledger. Same signature, result and definer posture.
CREATE OR REPLACE FUNCTION opengeni_private.credit_balance_by_account()
RETURNS TABLE(account_id uuid, balance_micros bigint)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT total.account_id, total.balance_micros::bigint AS balance_micros
  FROM credit_ledger_account_totals total
  ORDER BY total.account_id;
$$;
