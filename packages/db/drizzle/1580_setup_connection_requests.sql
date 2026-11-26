-- deployment-mode: rolling
-- "Ask an admin" on the Enable page (docs/agents.md, "Enable"): a member who
-- can't connect something a setup needs asks the workspace's admins in their
-- inbox.
--
-- * `opengeni_private.request_setup_connection_v1(account, workspace,
--   label, provider, name, link)` opens one inbox notice (a chat-less inbox
--   item, 1503) for each admin of the workspace: its organization's active
--   owners and admins, and members whose workspace role administers it
--   (`workspace_membership_administers`). Never the requester, at most 50,
--   and nobody in a Personal workspace.
-- * It trusts only the calling transaction's scope: the account and
--   workspace must be the ones `opengeni.account_id` and
--   `opengeni.workspace_id` name, the requester is `opengeni.subject_id`
--   and must belong to that workspace or its organization. Otherwise it asks
--   nobody and returns 0. `workspaces` and `workspace_memberships` aren't
--   FORCE row security, so the definer reads them unscoped: that check is
--   what keeps it to the caller's workspace. It reads the organization's
--   memberships (FORCE row security) through their
--   organization_membership_lifecycle policy arm, opened for those reads
--   only and restored on every exit, as 1503 does.
-- * One notice per requester, workspace and connection. Asking again while
--   it is open changes nothing; a settled one reopens, with fresh text, only
--   a day after it was settled, and a dismissed one stays dismissed. Returns
--   how many notices it opened or reopened.
-- * The runtime role's EXECUTE is withheld for one release
--   (DEFERRED_RUNTIME_PRIVATE_ROUTINES): the previous release refuses a
--   runtime grant on a definer it doesn't know. Until a later migration
--   grants it, the API answers "unavailable" and the page copies a link to
--   the step instead, as before.
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
      p_account_id uuid,
      p_workspace_id uuid,
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
      v_requester text := nullif(current_setting('opengeni.subject_id', true), '');
      v_key text;
      v_name text := left(btrim(coalesce(p_name, '')), 80);
      v_label text := left(nullif(btrim(coalesce(p_requester_label, '')), ''), 200);
      v_allowed boolean;
      v_recipients text[];
      v_recipient text;
      v_rows integer;
      v_asked integer := 0;
      v_previous_lifecycle text := current_setting('opengeni.organization_tenancy_lifecycle', true);
    BEGIN
      -- Only the caller's own scope, never one it passes in.
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR v_requester IS NULL
        OR p_account_id::text IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')
        OR p_workspace_id::text IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')
      THEN
        RETURN 0;
      END IF;
      IF char_length(v_requester) > 300
        OR p_provider IS NULL OR p_provider !~ '^[a-z0-9][a-z0-9.-]{0,99}$'
        OR v_name = ''
        OR p_link IS NULL OR char_length(p_link) > 1024
        OR NOT (starts_with(p_link, '/workspaces/' || p_workspace_id::text || '/enable?')
          OR starts_with(p_link, '/workspaces/' || p_workspace_id::text || '/get-started?'))
      THEN
        RAISE EXCEPTION 'invalid setup connection request' USING ERRCODE = '22023';
      END IF;

      -- The memberships' owner read arm, for these reads only.
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true);
      -- The workspace is in this account and isn't a Personal one (nobody
      -- administers it but its owner), and the requester belongs to it.
      v_allowed := EXISTS (
          SELECT 1 FROM workspaces workspace
          WHERE workspace.id = p_workspace_id AND workspace.account_id = p_account_id)
        AND NOT EXISTS (
          SELECT 1 FROM organization_memberships owner_row
          WHERE owner_row.account_id = p_account_id
            AND owner_row.personal_workspace_id = p_workspace_id)
        AND (
          EXISTS (
            SELECT 1 FROM workspace_memberships member
            WHERE member.account_id = p_account_id
              AND member.workspace_id = p_workspace_id
              AND member.subject_id = v_requester)
          OR EXISTS (
            SELECT 1 FROM organization_memberships member
            WHERE member.account_id = p_account_id
              AND member.subject_id = v_requester
              AND member.status = 'active' AND member.revoked_at IS NULL));
      IF v_allowed THEN
        SELECT coalesce(array_agg(admin.subject_id ORDER BY admin.subject_id), '{}')
          INTO v_recipients
        FROM (
          SELECT recipient.subject_id FROM (
            SELECT membership.subject_id
            FROM organization_memberships membership
            WHERE membership.account_id = p_account_id
              AND membership.status = 'active' AND membership.revoked_at IS NULL
              AND membership.role IN ('owner', 'admin')
            UNION
            SELECT grant_row.subject_id
            FROM workspace_memberships grant_row
            WHERE grant_row.account_id = p_account_id
              AND grant_row.workspace_id = p_workspace_id
              AND opengeni_private.workspace_membership_administers(
                grant_row.role, grant_row.permissions)
          ) recipient
          WHERE recipient.subject_id <> v_requester
          ORDER BY recipient.subject_id
          LIMIT 50
        ) admin;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(v_previous_lifecycle, ''), true);
      IF NOT v_allowed THEN
        RETURN 0;
      END IF;

      v_key := 'setup-request:' || p_workspace_id::text || ':' || p_provider || ':'
        || md5(v_requester);
      FOREACH v_recipient IN ARRAY v_recipients
      LOOP
        INSERT INTO opengeni_private.inbox_items AS item (
          account_id, workspace_id, session_id, recipient_subject_id, kind, source_key,
          title, subtitle, body, link, urgency, sender_subject_id, sender_label
        ) VALUES (
          p_account_id, p_workspace_id, NULL, v_recipient, 'notification', v_key,
          left('Connect ' || v_name, 200),
          left(v_name, 120),
          left(coalesce(v_label, 'A teammate') || ' asked you to connect ' || v_name
            || ' so a setup can turn on.', 2000),
          jsonb_build_object('url', p_link, 'label', 'Open setup'),
          'normal', v_requester, coalesce(v_label, 'A teammate')
        )
        ON CONFLICT (account_id, recipient_subject_id, kind, source_key)
          WHERE session_id IS NULL DO UPDATE SET
          title = excluded.title,
          subtitle = excluded.subtitle,
          body = excluded.body,
          link = excluded.link,
          sender_label = excluded.sender_label,
          status = 'open',
          resolved_at = NULL,
          content_version = item.content_version + 1,
          updated_at = now()
        -- Reopen a settled notice only a day after it was settled.
        WHERE item.status IN ('resolved', 'withdrawn')
          AND coalesce(item.resolved_at, item.updated_at) < now() - interval '1 day';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_asked := v_asked + v_rows;
      END LOOP;
      RETURN v_asked;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle', coalesce(v_previous_lifecycle, ''), true);
      RAISE;
    END
    $body$
  $definition$, data_schema);
END
$setup_connection_requests$;

REVOKE ALL ON FUNCTION opengeni_private.request_setup_connection_v1(
  uuid, uuid, text, text, text, text) FROM PUBLIC;
