-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: subscription_connections holds a handful of rows per organization, so stamping the sign-in time of each existing account once is instant.
-- online-safety-exception: constraint-validation: every existing inbox_items row has a session, so the new check holds for each row it reads in one pass.
-- online-safety-exception: nonconcurrent-index: the partial index covers only chat-less inbox items, and none exist before this migration, so it stays empty while it builds.
-- Tell the person who connected a subscription account when it needs signing
-- in again, and remember when each account was last signed in.
--
-- Until now an account that turned `needs_relogin` (its provider refused the
-- stored sign-in) told nobody: the person had to find it under Organization
-- settings > Models. Now the transition opens one inbox notification, with a
-- phone push, for the person who connected it, deduplicated per account and
-- sign-in. It links straight to that account's sign-in step. When that person
-- can no longer reconnect it (they left, or no longer administer where it
-- lives), the organization's owners and admins are told instead.
--
-- * `subscription_connections.signed_in_at`: when the account was last signed
--   in (connected or reconnected). A BEFORE trigger stamps it on insert and on
--   every sign-in, which is the one write that replaces the credential and
--   moves the row version together while leaving the account active; a
--   credential refresh moves neither the version nor the stamp. Existing rows
--   whose history shows no later sign-in (version 1, or version 2 that only
--   turned needs_relogin) get their creation time; any other row stays
--   unknown until its next sign-in.
-- * `opengeni_private.inbox_items.session_id` may be null for a notification
--   about something other than a chat. Such an item always carries a link,
--   and is unique per recipient and key. Existing chat items are unchanged,
--   and clients already show an item whose chat they can't open as its text
--   and link.
-- * `opengeni_private.open_subscription_relogin_notice_v1(connection)` opens
--   those notifications and queues their pushes (rule `needs_input`). An
--   AFTER trigger calls it when an account turns needs_relogin and resolves
--   them when it leaves that state (signed in again or disconnected). A
--   failure to notify never fails the status write.
-- * Accounts that turned needs_relogin in the last 14 days are told now.
--
-- No runtime role gains EXECUTE on anything: only triggers and this
-- migration call the new definer. It reads the connection and the
-- organization's memberships through their organization_membership_lifecycle
-- policy arms (opened for its own reads and restored on every exit), with no
-- locking clause, so FORCE row security on both tables admits its reads as
-- their owner (docs/force-rls-migration-backfills.md). The backfills below
-- run inside a NO FORCE window on subscription_connections for the same
-- reason.
--
-- Rolling: a nullable column and a relaxed NOT NULL the previous release
-- never writes; its inbox reader is the only one that would meet a chat-less
-- item, for the minutes until the new API replaces it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE subscription_connections ADD COLUMN signed_in_at timestamptz;

ALTER TABLE opengeni_private.inbox_items ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE opengeni_private.inbox_items ADD CONSTRAINT inbox_items_chatless_notification_check
  CHECK (session_id IS NOT NULL OR (kind = 'notification' AND link IS NOT NULL));
CREATE UNIQUE INDEX inbox_items_chatless_key
  ON opengeni_private.inbox_items (account_id, recipient_subject_id, kind, source_key)
  WHERE session_id IS NULL;

DO $subscription_relogin_notices$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.stamp_subscription_connection_sign_in()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW.credential_encrypted <> '' THEN
          NEW.signed_in_at := coalesce(NEW.signed_in_at, NEW.created_at, clock_timestamp());
        END IF;
      ELSIF NEW.credential_encrypted IS DISTINCT FROM OLD.credential_encrypted
        AND NEW.credential_encrypted <> ''
        AND NEW.version > OLD.version
        AND NEW.status = 'active'
      THEN
        -- A sign-in: connect and reconnect replace the credential and move
        -- the version together. A refresh never moves the version.
        NEW.signed_in_at := clock_timestamp();
      END IF;
      RETURN NEW;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.open_subscription_relogin_notice_v1(p_connection_id uuid)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_connection record;
      v_recipient record;
      v_connector text;
      v_connector_can_act boolean := false;
      v_service text;
      v_step text;
      v_key_provider text;
      v_name text;
      v_key text;
      v_title text;
      v_body text;
      v_path text;
      v_item uuid;
      v_opened integer := 0;
      v_previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
    BEGIN
      -- The connection's and memberships' owner read arm, for these reads only.
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
      SELECT connection.id, connection.account_id, connection.provider, connection.ownership,
          connection.owner_subject_id, connection.connected_by_subject_id,
          connection.managed_by_workspace_id, connection.label, connection.account_email,
          connection.status, connection.disconnected_at,
          coalesce(connection.signed_in_at, connection.created_at) AS signed_in
        INTO v_connection
      FROM subscription_connections connection
      WHERE connection.id = p_connection_id;
      IF NOT FOUND OR v_connection.status <> 'needs_relogin'
        OR v_connection.disconnected_at IS NOT NULL
      THEN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(v_previous_lifecycle, ''), true);
        RETURN 0;
      END IF;
      v_service := CASE v_connection.provider
        WHEN 'claude' THEN 'Claude' WHEN 'codex' THEN 'ChatGPT' ELSE 'SuperGrok' END;
      v_step := CASE v_connection.provider
        WHEN 'claude' THEN 'claude_subscription' WHEN 'codex' THEN 'codex' ELSE 'supergrok' END;
      v_key_provider := CASE v_connection.provider
        WHEN 'claude' THEN 'claude' WHEN 'codex' THEN 'codex' ELSE 'supergrok' END;
      v_name := left(coalesce(nullif(btrim(v_connection.label), ''),
        nullif(btrim(v_connection.account_email), ''), v_service || ' account'), 120);
      -- One notice per account and sign-in: a later refusal of the same
      -- sign-in never notifies again; a new sign-in that breaks again does.
      v_key := 'subscription-relogin:' || v_connection.id::text || ':'
        || floor(extract(epoch FROM v_connection.signed_in) * 1000)::bigint::text;

      -- The person who connected it, while they can still reconnect it.
      v_connector := CASE WHEN v_connection.ownership = 'personal'
        THEN v_connection.owner_subject_id ELSE v_connection.connected_by_subject_id END;
      IF v_connector IS NOT NULL THEN
        IF v_connection.ownership = 'personal' THEN
          v_connector_can_act := EXISTS (
            SELECT 1 FROM organization_memberships membership
            WHERE membership.account_id = v_connection.account_id
              AND membership.subject_id = v_connector
              AND membership.status = 'active' AND membership.revoked_at IS NULL);
        ELSE
          v_connector_can_act := EXISTS (
              SELECT 1 FROM organization_memberships membership
              WHERE membership.account_id = v_connection.account_id
                AND membership.subject_id = v_connector
                AND membership.status = 'active' AND membership.revoked_at IS NULL
                AND membership.role IN ('owner', 'admin'))
            OR (v_connection.managed_by_workspace_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM workspace_memberships grant_row
              WHERE grant_row.account_id = v_connection.account_id
                AND grant_row.workspace_id = v_connection.managed_by_workspace_id
                AND grant_row.subject_id = v_connector
                AND opengeni_private.workspace_membership_administers(
                  grant_row.role, grant_row.permissions)));
        END IF;
      END IF;

      FOR v_recipient IN
        SELECT membership.subject_id, membership.personal_workspace_id,
          membership.subject_id IS NOT DISTINCT FROM v_connector AS connector
        FROM organization_memberships membership
        WHERE membership.account_id = v_connection.account_id
          AND membership.status = 'active' AND membership.revoked_at IS NULL
          AND membership.personal_workspace_id IS NOT NULL
          AND CASE WHEN v_connector_can_act THEN membership.subject_id = v_connector
            ELSE membership.role IN ('owner', 'admin') END
        ORDER BY membership.subject_id
      LOOP
        -- Its own sign-in step, from the recipient's Personal workspace.
        v_path := '/workspaces/' || v_recipient.personal_workspace_id::text
          || '/organization?section=models'
          || CASE
            WHEN v_connection.ownership = 'personal'
              THEN '&workspace=' || v_recipient.personal_workspace_id::text
                || '&view=connect:' || v_step || '&account=' || v_key_provider || ':'
            WHEN v_connection.managed_by_workspace_id IS NOT NULL
              THEN '&workspace=' || v_connection.managed_by_workspace_id::text
                || '&view=connect:' || v_step || '&account=' || v_key_provider || ':'
            ELSE '&view=connect-org:' || v_step || '&account=org:' || v_key_provider || ':'
          END
          || v_connection.id::text;
        v_title := 'Sign in to ' || v_service || ' again';
        v_body := v_service || ' stopped accepting the sign-in for ' || v_name
          || ', so it can''t be used until someone signs in again. Sign in again opens '
          || 'this account''s sign-in directly.'
          || CASE WHEN v_recipient.connector THEN ''
            ELSE ' You''re told because the person who connected it can''t reconnect it.' END;
        v_item := NULL;
        INSERT INTO opengeni_private.inbox_items AS item (
          account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
          title, subtitle, body, link, urgency
        ) VALUES (
          v_connection.account_id, v_recipient.personal_workspace_id, NULL,
          v_recipient.subject_id, 'notification', v_key, left(v_title, 200),
          left(coalesce(v_connection.account_email, v_name), 120), left(v_body, 2000),
          jsonb_build_object('url', v_path, 'label', 'Sign in again'), 'normal'
        )
        ON CONFLICT (account_id, recipient_subject_id, kind, source_key)
          WHERE session_id IS NULL DO NOTHING
        RETURNING item.id INTO v_item;
        IF v_item IS NULL THEN
          CONTINUE;
        END IF;
        v_opened := v_opened + 1;
        INSERT INTO opengeni_private.native_push_deliveries (auth_session_id, dedupe_key, rule, payload)
        SELECT device.auth_session_id, v_key, 'needs_input',
          jsonb_strip_nulls(jsonb_build_object(
            'rule', 'needs_input',
            'eventType', 'subscription.connection.needs_relogin',
            'workspaceId', v_recipient.personal_workspace_id,
            'subjectId', device.subject_id,
            'title', left(v_title, 120),
            'subtitle', left(coalesce(v_connection.account_email, v_name), 160),
            'body', left(v_body, 1000),
            'link', v_path))
        FROM opengeni_private.native_push_devices device
        JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
        WHERE device.subject_id = v_recipient.subject_id AND 'needs_input' = ANY (device.rules)
        ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
      END LOOP;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(v_previous_lifecycle, ''), true);
      RETURN v_opened;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(v_previous_lifecycle, ''), true);
      RAISE;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.subscription_connection_relogin_notice()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      IF NEW.status = 'needs_relogin' AND OLD.status IS DISTINCT FROM 'needs_relogin' THEN
        PERFORM opengeni_private.open_subscription_relogin_notice_v1(NEW.id);
      ELSIF OLD.status = 'needs_relogin' AND NEW.status IS DISTINCT FROM 'needs_relogin' THEN
        -- Signed in again or disconnected: the notice has nothing left to ask.
        UPDATE opengeni_private.inbox_items item
        SET status = 'resolved', resolved_at = now(), updated_at = now()
        WHERE item.account_id = NEW.account_id AND item.session_id IS NULL
          AND item.kind = 'notification' AND item.status = 'open'
          AND item.source_key LIKE 'subscription-relogin:' || NEW.id::text || ':%%';
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      -- Telling someone never decides the account's health.
      RAISE WARNING 'subscription relogin notice skipped for %%: %%', NEW.id, SQLERRM;
      RETURN NULL;
    END
    $body$
  $definition$, data_schema);
END
$subscription_relogin_notices$;

REVOKE ALL ON FUNCTION opengeni_private.stamp_subscription_connection_sign_in() FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.open_subscription_relogin_notice_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_connection_relogin_notice() FROM PUBLIC;

CREATE TRIGGER subscription_connections_sign_in_trg
  BEFORE INSERT OR UPDATE OF credential_encrypted ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.stamp_subscription_connection_sign_in();

CREATE TRIGGER subscription_connections_relogin_notice_trg
  AFTER UPDATE OF status ON subscription_connections
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status
    AND (NEW.status = 'needs_relogin' OR OLD.status = 'needs_relogin'))
  EXECUTE FUNCTION opengeni_private.subscription_connection_relogin_notice();

-- Existing accounts: the sign-in time where the history shows no later one
-- (version 1, or version 2 that only turned needs_relogin), and a notice for
-- each account that turned needs_relogin in the last 14 days.
ALTER TABLE subscription_connections NO FORCE ROW LEVEL SECURITY;

UPDATE subscription_connections SET signed_in_at = created_at
WHERE signed_in_at IS NULL AND disconnected_at IS NULL
  AND (version = 1 OR (version = 2 AND status = 'needs_relogin'));

DO $subscription_relogin_backfill$
DECLARE
  v_id uuid;
  v_opened integer := 0;
BEGIN
  FOR v_id IN
    SELECT connection.id FROM subscription_connections connection
    WHERE connection.status = 'needs_relogin' AND connection.disconnected_at IS NULL
      AND connection.updated_at > now() - interval '14 days'
    ORDER BY connection.id
  LOOP
    v_opened := v_opened + opengeni_private.open_subscription_relogin_notice_v1(v_id);
  END LOOP;
  RAISE NOTICE 'subscription relogin notices opened: %', v_opened;
END
$subscription_relogin_backfill$;

ALTER TABLE subscription_connections FORCE ROW LEVEL SECURITY;
