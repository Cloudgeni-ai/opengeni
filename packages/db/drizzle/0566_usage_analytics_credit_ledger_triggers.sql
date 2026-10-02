-- deployment-mode: rolling
-- Usage analytics (see 0565): observe positive credit grants and capture the
-- `credits.granted` lifecycle fact on the credit ledger. Kept apart from 0565
-- so the ledger's SHARE ROW EXCLUSIVE trigger lock is held only for this short
-- transaction. A lock timeout fails only this file before anything changes;
-- rerunning the migration is safe.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '1min';

DROP TRIGGER IF EXISTS credit_grant_observation ON "credit_ledger_entries";
CREATE TRIGGER credit_grant_observation
AFTER INSERT ON "credit_ledger_entries"
FOR EACH ROW WHEN (NEW.type IN ('grant', 'manual_credit_grant') AND NEW.amount_micros > 0)
EXECUTE FUNCTION opengeni_private.observe_credit_grant();

DROP TRIGGER IF EXISTS product_lifecycle_fact_credits_granted ON "credit_ledger_entries";
CREATE TRIGGER product_lifecycle_fact_credits_granted
AFTER INSERT ON "credit_ledger_entries"
FOR EACH ROW WHEN (NEW.type IN ('grant', 'manual_credit_grant') AND NEW.amount_micros > 0)
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();
