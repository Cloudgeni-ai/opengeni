-- deployment-mode: rolling
-- "Ask an admin" on the Enable page (docs/agents.md, "Enable"): a member who
-- can't connect something a setup needs asks the workspace's admins in their
-- inbox.
--
-- * `opengeni_private.request_setup_connection_v1(workspace, requester,
--   label, provider, name, link)` opens one inbox notice (a chat-less inbox
--   item, 1503) for each admin of the workspace: its organization's active
--   owners and admins, and members whose workspace role administers it
--   (`workspace_membership_administers`). Never the requester, at most 50,
--   and nobody in a Personal workspace.
--   One notice per requester and connection: asking again reopens a settled
--   one and leaves a dismissed one dismissed, so asking twice never sends
--   twice. The link opens that Enable step (on the Enable page or Get
--   started) in this workspace only. It reads
--   the workspace and its members under the calling transaction's row
--   security, so it reaches only the workspace the caller is scoped to.
--   Returns how many admins were asked.
-- * The runtime role's EXECUTE is withheld for one release
--   (DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release refuses a
--   runtime grant on a definer it doesn't know. Until a later migration
--   grants it, the API answers "not available yet" and the page copies a
--   link to the step instead, as before.
--
-- Rolling: a new definer nobody can call yet; the previous release never
-- reads it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

DO $setup_connection_requests$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE pg_catalog.format($definition$
    CREATE FUNCTION opengeni_private.request_setup_connection_v1(
      p_workspace_id uuid,
      p_requester_subject_id text,
      p_requester_label text,
      p_provider text,
      p_name text,
      p_link text
    )
    RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      v_account uuid;
      v_key text;
      v_name text := left(btrim(coalesce(p_name, '')), 80);
      v_label text := left(nullif(btrim(coalesce(p_requester_label, '')), ''), 200);
      v_recipient text;
      v_asked integer := 0;
    BEGIN
      IF p_requester_subject_id IS NULL
        OR char_length(p_requester_subject_id) NOT BETWEEN 1 AND 300
        OR p_provider IS NULL OR p_provider !~ '^[a-z0-9][a-z0-9.-]{0,99}$'
        OR v_name = ''
        OR p_link IS NULL OR char_length(p_link) > 1024
        OR NOT (starts_with(p_link, '/workspaces/' || p_workspace_id::text || '/enable?')
          OR starts_with(p_link, '/workspaces/' || p_workspace_id::text || '/get-started?'))
      THEN
        RAISE EXCEPTION 'invalid setup connection request' USING ERRCODE = '22023';
      END IF;
      -- Only a workspace the calling transaction may see, and not a Personal
      -- one: nobody administers it but its owner.
      SELECT workspace.account_id INTO v_account
      FROM workspaces workspace
      WHERE workspace.id = p_workspace_id;
      IF v_account IS NULL OR EXISTS (
        SELECT 1 FROM organization_memberships owner_row
        WHERE owner_row.account_id = v_account
          AND owner_row.personal_workspace_id = p_workspace_id)
      THEN
        RETURN 0;
      END IF;
      v_key := left('setup-request:' || p_provider || ':' || p_requester_subject_id, 200);
      FOR v_recipient IN
        SELECT admin.subject_id FROM (
          SELECT membership.subject_id
          FROM organization_memberships membership
          WHERE membership.account_id = v_account
            AND membership.status = 'active' AND membership.revoked_at IS NULL
            AND membership.role IN ('owner', 'admin')
          UNION
          SELECT grant_row.subject_id
          FROM workspace_memberships grant_row
          WHERE grant_row.account_id = v_account
            AND grant_row.workspace_id = p_workspace_id
            AND opengeni_private.workspace_membership_administers(
              grant_row.role, grant_row.permissions)
        ) admin
        WHERE admin.subject_id <> p_requester_subject_id
        ORDER BY admin.subject_id
        LIMIT 50
      LOOP
        INSERT INTO opengeni_private.inbox_items AS item (
          account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
          title, subtitle, body, link, urgency, sender_subject_id, sender_label
        ) VALUES (
          v_account, p_workspace_id, NULL, v_recipient, 'notification', v_key,
          left('Connect ' || v_name, 200),
          left(v_name, 120),
          left(coalesce(v_label, 'A teammate') || ' asked you to connect ' || v_name
            || ' so a setup can turn on.', 2000),
          jsonb_build_object('url', p_link, 'label', 'Open setup'),
          'normal', p_requester_subject_id, coalesce(v_label, 'A teammate')
        )
        ON CONFLICT (account_id, recipient_subject_id, kind, source_key)
          WHERE session_id IS NULL DO UPDATE SET
          link = excluded.link,
          sender_label = excluded.sender_label,
          status = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN 'open' ELSE item.status END,
          resolved_at = CASE WHEN item.status IN ('resolved', 'withdrawn') THEN NULL ELSE item.resolved_at END,
          content_version = item.content_version + 1,
          updated_at = now();
        v_asked := v_asked + 1;
      END LOOP;
      RETURN v_asked;
    END
    $body$
  $definition$, data_schema);
END
$setup_connection_requests$;

REVOKE ALL ON FUNCTION opengeni_private.request_setup_connection_v1(
  uuid, text, text, text, text, text) FROM PUBLIC;
