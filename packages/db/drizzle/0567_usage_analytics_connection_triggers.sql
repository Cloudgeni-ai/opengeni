-- deployment-mode: rolling
-- Usage analytics (see 0565): capture the `connection.revoked` lifecycle fact
-- when a connection is revoked or a live one is deleted. Kept apart from 0565
-- so the SHARE ROW EXCLUSIVE trigger lock on connections is held only for this
-- short transaction. A lock timeout fails only this file before anything
-- changes; rerunning the migration is safe.
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '1min';

DROP TRIGGER IF EXISTS product_lifecycle_fact_connection_revoked ON "connections";
CREATE TRIGGER product_lifecycle_fact_connection_revoked
AFTER UPDATE OF "status" ON "connections"
FOR EACH ROW WHEN (NEW.status = 'revoked' AND OLD.status IS DISTINCT FROM 'revoked')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

-- Deleting a live connection removes it just as a revocation does; a row that
-- was already revoked was counted when it was revoked.
DROP TRIGGER IF EXISTS product_lifecycle_fact_connection_deleted ON "connections";
CREATE TRIGGER product_lifecycle_fact_connection_deleted
AFTER DELETE ON "connections"
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM 'revoked')
EXECUTE FUNCTION opengeni_private.capture_product_lifecycle_fact();

