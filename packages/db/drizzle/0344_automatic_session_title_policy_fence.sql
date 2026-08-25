-- deployment-mode: rolling
-- Automatic session titles are normalized in application code. Trigger DDL is
-- committed before the separately batched quarantine starts, so no heavyweight
-- table lock is held across a row scan. Unfenced old UPDATE writers are converted
-- to a no-op rather than raising, so a pre-policy scheduler still reaches
-- scheduled-occurrence delivery. Unfenced old create/fork/clone INSERTs receive
-- the neutral fallback.

SET LOCAL lock_timeout = '5s';

DROP TRIGGER IF EXISTS sessions_automatic_title_policy_v1_fence ON sessions;

-- FORCE RLS also binds the non-superuser table owner used by production
-- migrations. This persistent policy opens only an exact owner + transaction-
-- local capability seam; ordinary application roles cannot activate it. The
-- following migration uses that seam in one bounded statement per transaction.
DROP POLICY IF EXISTS sessions_automatic_title_quarantine_v1 ON sessions;
CREATE POLICY sessions_automatic_title_quarantine_v1 ON sessions
FOR ALL
USING (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'sessions'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
)
WITH CHECK (
  current_user = (
    SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation
    WHERE relation.oid = 'sessions'::regclass
  )
  AND pg_catalog.current_setting(
    'opengeni.automatic_session_title_quarantine_v1',
    true
  ) = '1'
);

CREATE OR REPLACE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  candidate text := nullif(
    pg_catalog.current_setting('opengeni.automatic_session_title_v1_candidate', true),
    ''
  );
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.title_source IS DISTINCT FROM 'user'
     AND (
       NEW.title IS DISTINCT FROM 'New conversation'
       OR NEW.title_source IS DISTINCT FROM 'agent'
     )
     AND (candidate IS NULL OR candidate IS DISTINCT FROM NEW.title)
  THEN
    -- Old create/fork/clone paths remain rolling- and rollback-compatible, but
    -- no unversioned automatic title crosses the new display boundary.
    NEW.title := 'New conversation';
    NEW.title_source := 'agent';
  ELSIF TG_OP = 'UPDATE'
     AND (OLD.title IS DISTINCT FROM NEW.title
      OR OLD.title_source IS DISTINCT FROM NEW.title_source)
     AND NEW.title_source = 'agent'
     AND (NEW.title IS DISTINCT FROM 'New conversation' OR OLD.title_source = 'user')
     AND (candidate IS NULL OR candidate IS DISTINCT FROM NEW.title)
  THEN
    -- Returning OLD title fields makes the pre-policy helper's RETURNING row
    -- and subsequent title event safe while allowing the dispatch to continue.
    NEW.title := OLD.title;
    NEW.title_source := OLD.title_source;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()
FROM PUBLIC;

CREATE TRIGGER sessions_automatic_title_policy_v1_fence
BEFORE INSERT OR UPDATE OF title, title_source ON sessions
FOR EACH ROW
EXECUTE FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1();
