-- deployment-mode: rolling
-- Automatic session titles are normalized in application code, but a rolling
-- deployment can briefly leave an older writer beside the new policy. Bind each
-- accepted automatic title to its exact transaction-local candidate so those
-- older writers fail closed instead of persisting prompt text or credentials.
-- Human titles and the neutral create fallback remain available to both versions.
-- Automatic generation is an UPDATE path. INSERT remains unfenced because the
-- database's fork/clone lifecycle functions intentionally copy an existing title.

CREATE OR REPLACE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (OLD.title IS DISTINCT FROM NEW.title
      OR OLD.title_source IS DISTINCT FROM NEW.title_source)
     AND NEW.title_source = 'agent'
     AND NEW.title IS DISTINCT FROM 'New conversation'
     AND pg_catalog.current_setting(
       'opengeni.automatic_session_title_v1_candidate',
       true
     ) IS DISTINCT FROM NEW.title
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '55000',
        MESSAGE = 'automatic session title requires the v1 normalized-title writer';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
FROM PUBLIC;

DROP TRIGGER IF EXISTS sessions_automatic_title_policy_v1_fence ON sessions;
CREATE TRIGGER sessions_automatic_title_policy_v1_fence
BEFORE UPDATE OF title, title_source ON sessions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1();