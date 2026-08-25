-- deployment-mode: rolling
-- Automatic session titles are normalized in application code. A bounded table
-- lock closes the quarantine/trigger-install race while old binaries remain
-- connected. Unfenced old UPDATE writers are converted to a no-op rather than
-- raising, so a pre-policy scheduler still reaches scheduled-occurrence delivery.
-- Unfenced old create/fork/clone INSERTs receive the neutral fallback.

SET LOCAL lock_timeout = '5s';

LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS sessions_automatic_title_policy_v1_fence ON sessions;

-- Existing non-user titles predate the normalization policy and have no durable
-- proof that they are safe. Preserve explicit human edits and quarantine every
-- automatic/unversioned row before the trigger boundary becomes active.
-- The migration owner has no BYPASSRLS, so temporarily relax FORCE RLS for the
-- owner only; application roles remain policy-bound throughout the transaction.
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;

UPDATE sessions
SET title = 'New conversation', title_source = 'agent'
WHERE title_source IS DISTINCT FROM 'user'
  AND (
    title IS DISTINCT FROM 'New conversation'
    OR title_source IS DISTINCT FROM 'agent'
  );

ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

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
