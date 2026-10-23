-- deployment-mode: rolling
-- MCP Events subscriptions. An MCP event source is one person's connection to
-- an MCP server that offers the events extension (SEP-3415). Each distinct
-- (event name, arguments) its automations' triggers ask for is one
-- subscription: Opengeni polls it, or the server delivers to the
-- subscription's own webhook URL. The subscription owns the cursor, the
-- server's subscription id and the webhook secret, and is removed once no
-- runnable automation wants it.
--
-- A trigger and an event name the stream they belong to (`stream_key`, a
-- digest of the event name and canonical arguments; empty for every other
-- source), so an MCP event only fires the triggers of its own subscription.
-- Deliveries record their stream too, so they can be replayed into it.
--
-- New table and defaulted columns only. Older binaries never read the table
-- and write the empty stream key, which is what non-MCP sources use.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE event_triggers
  ADD COLUMN stream_key text NOT NULL DEFAULT ''
    CHECK (stream_key = '' OR stream_key ~ '^[0-9a-f]{64}$');
ALTER TABLE event_deliveries
  ADD COLUMN stream_key text NOT NULL DEFAULT ''
    CHECK (stream_key = '' OR stream_key ~ '^[0-9a-f]{64}$');
CREATE INDEX event_triggers_stream_idx ON event_triggers(workspace_id, source_id, stream_key)
  WHERE stream_key <> '';

CREATE TABLE mcp_event_subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  -- sha256 of the event name and canonical arguments: the spec's subscription
  -- identity, and the stream its events are deduplicated in.
  stream_key text NOT NULL CHECK (stream_key ~ '^[0-9a-f]{64}$'),
  event_name text NOT NULL CHECK (octet_length(event_name) BETWEEN 1 AND 200),
  arguments jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(arguments) = 'object'
    AND octet_length(arguments::text) <= 16384),
  -- Chosen on the first step: webhook when the event type offers it and the
  -- deployment has a public https origin, otherwise poll.
  mode text CHECK (mode IS NULL OR mode IN ('poll', 'webhook')),
  -- The last safe-to-persist position the server gave; NULL means "from now".
  cursor text CHECK (cursor IS NULL OR octet_length(cursor) <= 4096),
  -- The server reported skipped events; the next stored event says so.
  gap_pending boolean NOT NULL DEFAULT false,
  -- Webhook mode: the callback URL's route and the encrypted signing secret.
  route_id uuid UNIQUE,
  secret_encrypted text,
  -- Webhook mode: the server's id for the subscription and its expiry.
  server_subscription_id text CHECK (server_subscription_id IS NULL
    OR octet_length(server_subscription_id) BETWEEN 1 AND 512),
  refresh_before timestamptz,
  -- When the pump next polls, subscribes, refreshes or retries.
  next_action_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- Consecutive failed steps, since when, and the last error in plain language.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  failing_since timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 500),
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_event_subscriptions_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT mcp_event_subscriptions_stream_uq UNIQUE (source_id, stream_key),
  CONSTRAINT mcp_event_subscriptions_webhook_chk CHECK (
    (route_id IS NULL) = (secret_encrypted IS NULL)
    AND (server_subscription_id IS NULL OR coalesce(mode, '') = 'webhook')
  )
);
CREATE INDEX mcp_event_subscriptions_due_idx ON mcp_event_subscriptions(next_action_at, id);
CREATE INDEX mcp_event_subscriptions_workspace_idx
  ON mcp_event_subscriptions(workspace_id, source_id);

ALTER TABLE mcp_event_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_event_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON mcp_event_subscriptions
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));
-- FORCE RLS also binds the table owner; the identity-only listing below runs
-- as the owner and gets an exact owner-only policy.
CREATE POLICY mcp_event_subscription_maintenance_owner ON mcp_event_subscriptions
  USING (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation WHERE relation.oid = 'mcp_event_subscriptions'::regclass))
  WITH CHECK (current_user = (SELECT pg_catalog.pg_get_userbyid(relation.relowner)
    FROM pg_catalog.pg_class relation WHERE relation.oid = 'mcp_event_subscriptions'::regclass));
REVOKE ALL ON TABLE mcp_event_subscriptions FROM PUBLIC;

-- The subscription pump is one cross-workspace loop. It finds subscriptions
-- whose next step is due and unleased through this identity-only function;
-- claiming and every read and write after it happen in the workspace scope.
CREATE FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(p_limit integer)
RETURNS TABLE (subscription_id uuid, workspace_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path FROM CURRENT
AS $list_due_mcp_event_subscriptions$
  SELECT subscription.id, subscription.workspace_id
  FROM mcp_event_subscriptions subscription
  WHERE subscription.next_action_at <= pg_catalog.now()
    AND (subscription.lease_until IS NULL OR subscription.lease_until <= pg_catalog.now())
  ORDER BY subscription.next_action_at, subscription.id
  LIMIT greatest(1, least(coalesce(p_limit, 32), 200));
$list_due_mcp_event_subscriptions$;

REVOKE ALL ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(integer) FROM PUBLIC;

DO $mcp_event_subscription_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mcp_event_subscriptions TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.list_due_mcp_event_subscriptions_v1(integer)
      TO opengeni_app;
  END IF;
END $mcp_event_subscription_grants$;
