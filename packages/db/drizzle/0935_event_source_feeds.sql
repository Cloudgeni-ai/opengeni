-- deployment-mode: rolling
-- Event source feeds. Some apps have no webhook Opengeni can receive, so
-- Opengeni reads the app's own change history instead: Gmail's mailbox
-- history today. A feed is that reading position for one source, kept while a
-- runnable automation listens to the source. The feed pump claims due feeds,
-- reads what changed as the source's owner, and records it through the
-- ordinary event intake. A feed nothing listens to forgets its position, so
-- it starts from "now" when an automation listens again.
--
-- New table only. Older binaries never read or write it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

CREATE TABLE event_source_feeds (
  source_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The app's position after the last recorded change (Gmail: a history id);
  -- NULL means "from now".
  cursor text CHECK (cursor IS NULL OR octet_length(cursor) BETWEEN 1 AND 4096),
  -- The app no longer had the history since the cursor; the next stored
  -- event says events may be missing before it.
  gap_pending boolean NOT NULL DEFAULT false,
  -- When the pump next reads the feed.
  next_action_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- Consecutive failed reads, since when, and the last error.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  failing_since timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 500),
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_source_feeds_source_fk FOREIGN KEY (workspace_id, source_id)
    REFERENCES event_sources(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT event_source_feeds_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX event_source_feeds_due_idx ON event_source_feeds(next_action_at, source_id);
CREATE INDEX event_source_feeds_workspace_idx ON event_source_feeds(workspace_id, source_id);

ALTER TABLE event_source_feeds ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_source_feeds FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON event_source_feeds
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- FORCE RLS also binds the table owner; the identity-only listing below runs
-- as the owner and gets an exact owner-only policy.
CREATE POLICY event_source_feed_maintenance_owner ON event_source_feeds
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation WHERE relation.oid = 'event_source_feeds'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation WHERE relation.oid = 'event_source_feeds'::regclass));
REVOKE ALL ON TABLE event_source_feeds FROM PUBLIC;

-- The feed pump is one cross-workspace loop. It finds feeds whose next read
-- is due and unleased through this identity-only function; claiming and every
-- read and write after it happen in the workspace scope.
CREATE FUNCTION opengeni_private.list_due_event_source_feeds_v1(p_limit integer)
RETURNS TABLE (source_id uuid, workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $list_due_event_source_feeds$
  SELECT feed.source_id, feed.workspace_id
  FROM event_source_feeds feed
  WHERE feed.next_action_at <= pg_catalog.now()
    AND (feed.lease_until IS NULL OR feed.lease_until <= pg_catalog.now())
  ORDER BY feed.next_action_at, feed.source_id
  LIMIT greatest(1, least(coalesce(p_limit, 32), 200));
$list_due_event_source_feeds$;

REVOKE ALL ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(integer) FROM PUBLIC;

DO $event_source_feed_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE event_source_feeds TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_due_event_source_feeds_v1(integer)
      TO opengeni_app;
  END IF;
END $event_source_feed_grants$;
