-- deployment-mode: rolling
-- Webhooks into apps and notifications from apps (docs/app-webhooks.md,
-- docs/site-runtime-api.md "Notify people").
--
-- * app_webhooks: an app's inbound webhook addresses. Each names one shared
--   collection of the app's data and how a delivery becomes records (the
--   data sync mapping: records path, key path, kept fields). The secret is
--   shown once; the row keeps its SHA-256 (bearer deliveries) and an
--   encrypted copy (HMAC signatures need the secret itself), never the value
--   in readable form. A per-webhook delivery window (window_started_at,
--   window_count) rate limits deliveries in one atomic update.
-- * app_notifications: one row per site.notify call. The runtime role only
--   inserts and reads rows (reads count the sender's recent sends for the
--   rate limit). An AFTER INSERT trigger calls
--   opengeni_private.deliver_app_notification_v1(notification), which as the
--   tables' owner opens or updates each recipient's inbox notice (an inbox
--   item about something other than a chat, 1503: no session, always a link
--   into the app) and queues its phone pushes under each device's `agent`
--   rule. It delivers only a notification inserted in the calling
--   transaction. A failure to notify one person never fails the insert. Rows
--   older than a day are pruned by the same routine, per app.
--
-- The trigger function is an ordinary (invoker) trigger, and the runtime
-- role's EXECUTE on the delivery routine is withheld for one release
-- (DEFERRED_RUNTIME_PRIVATE_ROUTINES), like 1503: the previous release
-- refuses an owner-only trigger definer, or a runtime grant on a definer, it
-- doesn't know. Until a later migration grants it, the API refuses
-- site.notify as not yet available instead of storing an undelivered send.
--
-- Rolling: two new tables, a new trigger and a definer nobody can call yet;
-- the previous release never reads or writes any of them.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

CREATE TABLE app_webhooks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  name text NOT NULL,
  collection text NOT NULL,
  records_path text,
  key_path text,
  fields jsonb,
  status text NOT NULL DEFAULT 'active',
  secret_hash text NOT NULL,
  secret_encrypted text NOT NULL,
  created_by_subject_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_delivery_at timestamptz,
  last_status text,
  last_error text,
  window_started_at timestamptz,
  window_count integer NOT NULL DEFAULT 0,
  CONSTRAINT app_webhooks_pkey PRIMARY KEY (id),
  CONSTRAINT app_webhooks_name_check CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT app_webhooks_collection_check CHECK (char_length(collection) BETWEEN 1 AND 64),
  CONSTRAINT app_webhooks_paths_check CHECK (
    (records_path IS NULL OR char_length(records_path) BETWEEN 1 AND 256)
    AND (key_path IS NULL OR char_length(key_path) BETWEEN 1 AND 256)
  ),
  CONSTRAINT app_webhooks_fields_check CHECK (
    fields IS NULL OR (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 100)
  ),
  CONSTRAINT app_webhooks_status_check CHECK (status IN ('active', 'paused')),
  CONSTRAINT app_webhooks_secret_check CHECK (
    secret_hash ~ '^[0-9a-f]{64}$' AND char_length(secret_encrypted) BETWEEN 1 AND 4096
  ),
  CONSTRAINT app_webhooks_creator_check CHECK (char_length(created_by_subject_id) BETWEEN 1 AND 1024),
  CONSTRAINT app_webhooks_last_status_check
    CHECK (last_status IS NULL OR last_status IN ('succeeded', 'failed', 'rejected')),
  CONSTRAINT app_webhooks_last_error_check CHECK (last_error IS NULL OR char_length(last_error) <= 2000),
  CONSTRAINT app_webhooks_window_check CHECK (window_count >= 0),
  CONSTRAINT app_webhooks_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_webhooks_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX app_webhooks_site_idx ON app_webhooks (workspace_id, site_id);
COMMENT ON TABLE app_webhooks IS 'Inbound webhook addresses of an app: each delivery becomes records of one shared collection.';

CREATE TABLE app_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  site_id uuid NOT NULL,
  sender_subject_id text NOT NULL,
  sender_label text NOT NULL,
  app_title text NOT NULL,
  audience text NOT NULL,
  recipients text[] NOT NULL,
  notice_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_notifications_pkey PRIMARY KEY (id),
  CONSTRAINT app_notifications_sender_check CHECK (
    char_length(sender_subject_id) BETWEEN 1 AND 300 AND char_length(sender_label) BETWEEN 1 AND 200
  ),
  CONSTRAINT app_notifications_app_title_check CHECK (char_length(app_title) BETWEEN 1 AND 120),
  CONSTRAINT app_notifications_audience_check CHECK (audience IN ('people', 'workspace')),
  CONSTRAINT app_notifications_recipients_check CHECK (
    cardinality(recipients) BETWEEN 1 AND 200 AND array_position(recipients, NULL) IS NULL
  ),
  CONSTRAINT app_notifications_key_check CHECK (notice_key ~ '^[A-Za-z0-9._:-]{1,120}$'),
  CONSTRAINT app_notifications_title_check CHECK (char_length(title) BETWEEN 1 AND 200),
  CONSTRAINT app_notifications_body_check CHECK (char_length(body) <= 2000),
  -- The link always opens this app in the console.
  CONSTRAINT app_notifications_link_check CHECK (
    char_length(link) <= 1024
    AND (link = '/workspaces/' || workspace_id::text || '/sites/' || site_id::text
      OR starts_with(link, '/workspaces/' || workspace_id::text || '/sites/' || site_id::text || '?page=%2F'))
  ),
  CONSTRAINT app_notifications_workspace_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  CONSTRAINT app_notifications_site_fk FOREIGN KEY (workspace_id, site_id)
    REFERENCES workspace_artifacts(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX app_notifications_sender_idx
  ON app_notifications (workspace_id, site_id, sender_subject_id, created_at);
CREATE INDEX app_notifications_site_created_idx ON app_notifications (workspace_id, site_id, created_at);
COMMENT ON TABLE app_notifications IS 'Notifications an app page sent (site.notify); a trigger delivers each to its recipients'' inboxes and phones.';

ALTER TABLE app_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_webhooks FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_webhooks
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

ALTER TABLE app_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON app_notifications
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

REVOKE ALL ON TABLE app_webhooks FROM PUBLIC;
REVOKE ALL ON TABLE app_notifications FROM PUBLIC;

DO $app_notifications$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.deliver_app_notification_v1(p_notification uuid)
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_sent app_notifications%%ROWTYPE;
      v_recipient text;
      v_key text;
      v_previous text;
      v_item uuid;
      v_version integer;
      v_from_other boolean;
      v_delivered integer := 0;
    BEGIN
      -- Only a send made in this transaction, read under the caller's
      -- workspace row security: an old send is never delivered again.
      SELECT sent.* INTO v_sent FROM app_notifications sent
      WHERE sent.id = p_notification AND sent.created_at = now();
      IF NOT FOUND THEN
        RETURN 0;
      END IF;
      v_key := 'app:' || v_sent.site_id::text || ':' || v_sent.notice_key;
      FOREACH v_recipient IN ARRAY v_sent.recipients LOOP
        BEGIN
          v_from_other := v_recipient IS DISTINCT FROM v_sent.sender_subject_id;
          SELECT item.status INTO v_previous FROM opengeni_private.inbox_items item
          WHERE item.account_id = v_sent.account_id AND item.recipient_subject_id = v_recipient
            AND item.kind = 'notification' AND item.source_key = v_key
            AND item.session_id IS NULL;
          -- The same key updates the person's notice in place, like an
          -- agent's notification: resolved or withdrawn notices open again,
          -- a dismissed one stays dismissed.
          INSERT INTO opengeni_private.inbox_items AS item (
            account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
            title, subtitle, body, link, urgency, sender_subject_id, sender_label
          ) VALUES (
            v_sent.account_id, v_sent.workspace_id, NULL, v_recipient, 'notification', v_key,
            left(v_sent.title, 200), left(v_sent.app_title, 120), left(v_sent.body, 2000),
            jsonb_build_object('url', v_sent.link, 'label', 'Open app'), 'normal',
            CASE WHEN v_from_other THEN v_sent.sender_subject_id END,
            CASE WHEN v_from_other THEN left(v_sent.sender_label, 200) END
          )
          ON CONFLICT (account_id, recipient_subject_id, kind, source_key)
            WHERE session_id IS NULL DO UPDATE SET
            workspace_id = excluded.workspace_id,
            title = excluded.title,
            subtitle = excluded.subtitle,
            body = excluded.body,
            link = excluded.link,
            sender_subject_id = excluded.sender_subject_id,
            sender_label = excluded.sender_label,
            status = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN 'open' ELSE item.status END,
            resolved_at = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN NULL ELSE item.resolved_at END,
            content_version = item.content_version + 1,
            updated_at = now()
          RETURNING item.id, item.content_version INTO v_item, v_version;
          -- A phone alert only for a new or reopened notice; an update in
          -- place changes what the inbox shows without alerting again.
          IF v_previous IS NULL OR v_previous IN ('resolved', 'withdrawn') THEN
            INSERT INTO opengeni_private.native_push_deliveries (auth_session_id, dedupe_key, rule, payload)
            SELECT device.auth_session_id, 'app-notice:' || v_item::text || ':' || v_version::text,
              'agent',
              jsonb_strip_nulls(jsonb_build_object(
                'rule', 'agent',
                'eventType', 'app.notification',
                'workspaceId', v_sent.workspace_id,
                'subjectId', device.subject_id,
                'title', left(v_sent.title, 120),
                'subtitle', left(CASE WHEN v_from_other
                  THEN v_sent.app_title || ' · ' || v_sent.sender_label ELSE v_sent.app_title END, 160),
                'body', left(nullif(v_sent.body, ''), 1000),
                'link', v_sent.link))
            FROM opengeni_private.native_push_devices device
            JOIN auth_sessions auth ON auth.id = device.auth_session_id AND auth.expires_at > now()
            WHERE device.subject_id = v_recipient AND 'agent' = ANY (device.rules)
            ON CONFLICT (auth_session_id, dedupe_key) DO NOTHING;
          END IF;
          v_delivered := v_delivered + 1;
        EXCEPTION WHEN OTHERS THEN
          -- One person's notice never fails the others or the send.
          RAISE WARNING 'app notification skipped for a recipient of %%: %%', v_sent.id, SQLERRM;
        END;
      END LOOP;
      -- Sends older than a day no longer count toward any rate limit.
      DELETE FROM app_notifications sent
      WHERE sent.workspace_id = v_sent.workspace_id AND sent.site_id = v_sent.site_id
        AND sent.created_at < now() - interval '1 day';
      RETURN v_delivered;
    END
    $body$
  $definition$, data_schema);

  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.deliver_app_notification()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    BEGIN
      -- Runs as the inserting role, which may deliver once its EXECUTE is
      -- granted (the API checks before it inserts).
      IF pg_catalog.has_function_privilege(
        'opengeni_private.deliver_app_notification_v1(uuid)', 'EXECUTE')
      THEN
        PERFORM opengeni_private.deliver_app_notification_v1(NEW.id);
      END IF;
      RETURN NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'app notification %% not delivered: %%', NEW.id, SQLERRM;
      RETURN NULL;
    END
    $body$
  $definition$, data_schema);
END
$app_notifications$;

REVOKE ALL ON FUNCTION opengeni_private.deliver_app_notification_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.deliver_app_notification() FROM PUBLIC;

CREATE TRIGGER app_notifications_deliver_trg
  AFTER INSERT ON app_notifications
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.deliver_app_notification();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, DELETE, UPDATE ON TABLE app_webhooks TO opengeni_app';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE app_notifications TO opengeni_app';
  END IF;
END
$$;
