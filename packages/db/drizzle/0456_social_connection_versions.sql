-- deployment-mode: maintenance
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE social_connections ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
CREATE FUNCTION bump_social_connection_version() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $body$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END
$body$;
REVOKE ALL ON FUNCTION bump_social_connection_version() FROM PUBLIC;
CREATE TRIGGER social_connection_version BEFORE UPDATE ON social_connections
FOR EACH ROW EXECUTE FUNCTION bump_social_connection_version();