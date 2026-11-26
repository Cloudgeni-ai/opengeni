-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: inserts one empty totals row per managed account (about 2k in production, no ledger read) under the trigger lock; the ledger sums are filled online by the batched backfill 1577.
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
-- statement-level triggers on the ledger's inserts, updates and deletes in the
-- same transaction as the ledger change, and cleared by a TRUNCATE. A row is
-- `ready` once it holds the account's whole sums; readers use a ready row and
-- recount the ledger otherwise (rollout only, or an account with no row).
--
-- Exact, online rollout:
-- 1. The triggers are created first. CREATE TRIGGER takes SHARE ROW EXCLUSIVE
--    on the ledger, which waits for in-flight ledger writes and holds off new
--    ones until this migration commits. Every row written before that point
--    is committed; every later change goes through the triggers.
-- 2. Under that lock, every managed account gets a not-ready row at zero (no
--    ledger read, so the lock window stays short). From then on the triggers
--    add each change's delta to it, ready or not: the row holds the sum of
--    every change after step 1.
-- 3. 1577 fills the rest in small online batches: in one statement (one
--    snapshot) it reads the ledger sum and the row, and adds the difference
--    (the sum of the rows written before step 1) to the latest row version,
--    then marks it ready. A concurrent writer's delta is either in both the
--    ledger sum and the row read, or in neither and lands in the latest row.
--    No advisory lock is held while the ledger is read; a writer waits at most
--    for the batch's single-row update to commit.
-- An account with no row has no change since step 1 and existed after it, so
-- the first ledger change creates its row ready.
--
-- Before it changes an account's totals the trigger takes that account's
-- credit lock, pg_advisory_xact_lock(hashtext(account)), as the plan refund
-- trigger already does, in sorted account order. Ledger writers already hold
-- it (re-entrant), so they wait for nothing new; a writer that does not is
-- serialized per account at its ledger write, so the totals row lock always
-- nests inside the credit lock, never the other way round. One consequence: a
-- writer that holds an account's credit lock while that account is deleted
-- can now fail with a deadlock (40P01) instead of a foreign-key error, because
-- the deletion's ledger cascade waits for the same lock; both abort the
-- writer, and the deletion proceeds.
--
-- Nobody sets a balance directly. The trigger functions are SECURITY INVOKER
-- with a pinned search_path (a definer trigger needs an earlier binary's
-- contract, docs/migrations-expand-contract.md), so a ledger writer updates
-- the totals as itself; the runtime's INSERT and UPDATE policies admit a row
-- of its own account only from inside a trigger (pg_trigger_depth() > 0), and
-- the only trigger that writes the table applies exact ledger deltas. A direct
-- runtime INSERT fails and a direct UPDATE or DELETE changes nothing. The
-- owner policy covers the owner's ledger writes and the backfill.
--
-- Rolling: a new table (FORCE RLS, runtime SELECT, and INSERT and UPDATE for
-- the triggers), owner-only invoker routines and triggers. The previous
-- release still sums the ledger and never reads the table; its ledger writes
-- keep the totals current through the triggers.
SET LOCAL lock_timeout = '5s';

CREATE TABLE credit_ledger_account_totals (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  -- sum(amount_micros) over the account's ledger.
  balance_micros numeric NOT NULL DEFAULT 0,
  -- sum(-amount_micros) over its API rows other than own-key fees
  -- (usage_origin = 'api' and type <> 'byok_platform_fee').
  api_spent_micros numeric NOT NULL DEFAULT 0,
  -- The sums include the rows written before the triggers existed (1577).
  ready boolean NOT NULL DEFAULT false
);
COMMENT ON TABLE credit_ledger_account_totals IS
  'Per-account sums over credit_ledger_entries, kept exact by statement triggers (1576); readers recount a row that is not ready.';

ALTER TABLE credit_ledger_account_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger_account_totals FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_ledger_account_totals_account_read ON credit_ledger_account_totals
  FOR SELECT USING (account_id = opengeni_private.current_account_id());
CREATE POLICY credit_ledger_account_totals_trigger_insert ON credit_ledger_account_totals
  FOR INSERT WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
CREATE POLICY credit_ledger_account_totals_trigger_update ON credit_ledger_account_totals
  FOR UPDATE USING (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0)
  WITH CHECK (account_id = opengeni_private.current_account_id() AND pg_trigger_depth() > 0);
REVOKE ALL ON TABLE credit_ledger_account_totals FROM PUBLIC;

DO $credit_ledger_account_totals$
DECLARE data_schema text := current_schema(); owner_name text := current_user;
BEGIN
  -- The owner's own ledger writes (in any tenant context) and the backfill.
  EXECUTE format(
    'CREATE POLICY credit_ledger_account_totals_owner ON %1$I.credit_ledger_account_totals '
    'TO %2$I USING (CURRENT_USER = %3$L::name) WITH CHECK (CURRENT_USER = %3$L::name)',
    data_schema, owner_name, owner_name);

  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.maintain_credit_ledger_account_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE changed uuid; changed_ids uuid[]; changed_balances numeric[]; changed_api_spent numeric[];
    BEGIN
      IF TG_OP = 'INSERT' THEN
        FOR changed IN SELECT DISTINCT added.account_id FROM added ORDER BY 1 LOOP
          PERFORM pg_advisory_xact_lock(hashtext(changed::text));
        END LOOP;
        -- A new row is ready: its account has no change before the triggers.
        INSERT INTO %1$I.credit_ledger_account_totals AS total (account_id, balance_micros, api_spent_micros, ready)
        SELECT added.account_id, sum(added.amount_micros),
          coalesce(sum(-added.amount_micros) FILTER (WHERE added.usage_origin = 'api'
            AND added.type <> 'byok_platform_fee'), 0), true
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
        INSERT INTO %1$I.credit_ledger_account_totals AS total (account_id, balance_micros, api_spent_micros, ready)
        SELECT delta.account_id, delta.balance, delta.api_spent, true
        FROM unnest(changed_ids, changed_balances, changed_api_spent) AS delta(account_id, balance, api_spent)
        ORDER BY delta.account_id
        ON CONFLICT (account_id) DO UPDATE
          SET balance_micros = total.balance_micros + excluded.balance_micros,
            api_spent_micros = total.api_spent_micros + excluded.api_spent_micros;
      END IF;
      RETURN NULL;
    END $body$;
  $create$, data_schema);

  -- A TRUNCATE empties the ledger: every account's sums are zero, which no
  -- row (the first later change creates a ready one) expresses exactly.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.clear_credit_ledger_account_totals() RETURNS trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    BEGIN
      DELETE FROM %1$I.credit_ledger_account_totals;
      RETURN NULL;
    END $body$;
  $create$, data_schema);

  -- The rows written before the triggers, for one account: its ledger sums
  -- minus what its totals row already holds, read in one snapshot so a
  -- concurrent change is in both or in neither. The caller adds the result to
  -- the latest row version. Owner only (the 1577 backfill); the tenant
  -- settings make the account's ledger rows visible under FORCE RLS for this
  -- one statement and are restored after it.
  EXECUTE format($create$
    CREATE FUNCTION opengeni_private.credit_ledger_account_totals_backlog(p_account_id uuid)
    RETURNS TABLE (balance_micros numeric, api_spent_micros numeric)
    LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, %1$I, pg_temp AS $body$
    DECLARE prior_account text := current_setting('opengeni.account_id', true);
      prior_workspace text := current_setting('opengeni.workspace_id', true);
    BEGIN
      PERFORM set_config('opengeni.account_id', p_account_id::text, true),
        set_config('opengeni.workspace_id', '', true);
      RETURN QUERY
        SELECT coalesce(ledger.balance, 0) - total.balance_micros,
          coalesce(ledger.api_spent, 0) - total.api_spent_micros
        FROM %1$I.credit_ledger_account_totals total
        CROSS JOIN LATERAL (
          SELECT sum(entry.amount_micros) AS balance,
            sum(-entry.amount_micros) FILTER (WHERE entry.usage_origin = 'api'
              AND entry.type <> 'byok_platform_fee') AS api_spent
          FROM %1$I.credit_ledger_entries entry
          WHERE entry.account_id = p_account_id) ledger
        WHERE total.account_id = p_account_id;
      PERFORM set_config('opengeni.account_id', coalesce(prior_account, ''), true),
        set_config('opengeni.workspace_id', coalesce(prior_workspace, ''), true);
    END $body$;
  $create$, data_schema);

  -- The per-account balance gauge (every ~28 s) reads the totals instead of
  -- summing the whole ledger; a row that is not ready yet is recounted as
  -- before. Same signature and definer posture, now with a pinned search_path.
  EXECUTE format($create$
    CREATE OR REPLACE FUNCTION opengeni_private.credit_balance_by_account()
    RETURNS TABLE(account_id uuid, balance_micros bigint)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, %1$I, pg_temp AS $body$
      SELECT total.account_id,
        CASE WHEN total.ready THEN total.balance_micros
          ELSE (SELECT coalesce(sum(entry.amount_micros), 0) FROM %1$I.credit_ledger_entries entry
            WHERE entry.account_id = total.account_id) END::bigint AS balance_micros
      FROM %1$I.credit_ledger_account_totals total
      ORDER BY total.account_id;
    $body$;
  $create$, data_schema);
END $credit_ledger_account_totals$;
REVOKE ALL ON FUNCTION opengeni_private.maintain_credit_ledger_account_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.clear_credit_ledger_account_totals() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.credit_ledger_account_totals_backlog(uuid) FROM PUBLIC;

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
CREATE TRIGGER credit_ledger_account_totals_truncate AFTER TRUNCATE ON credit_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION opengeni_private.clear_credit_ledger_account_totals();

-- Step 2, under the trigger lock: every account that can have earlier ledger
-- rows (managed_accounts has no FORCE RLS, so the owner sees them all).
INSERT INTO credit_ledger_account_totals (account_id)
SELECT account.id FROM managed_accounts account
ORDER BY account.id;

-- Every configured application role, as provisioning does. INSERT and UPDATE
-- serve only the invoker triggers (the policies admit nothing else).
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
