-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: reads only personal OAuth logins, a few per person; moves only the tool choices, turn-ons and pins of logins that duplicate another
-- One account, one login, across OAuth clients. Migration 1226 merged
-- duplicate personal logins only when they were made with the same OAuth
-- client. A deployment that replaced its registered client (staging's Google
-- client changed twice) left the same mailbox saved under each client: two
-- "me@example.com" logins with tool choices split between them, and removing
-- one could leave the connector saying "Sign in again". Connecting now treats
-- the authorization server's issuer, not the client, as naming the account
-- (apps/api/src/integrations/oauth-account-identity.ts), so no new duplicate
-- is saved; this merges the ones saved before.
--
-- The rules are 1226's, without the client in the grouping. Two logins are
-- the same account when they belong to the same person in the same
-- organization, sign in to the same server the same way (exact MCP URL,
-- provider and authorization server), and the service verified the same
-- account identity: Slack (team and user), Gmail, Google Calendar, Google
-- Drive and Atlassian. A login whose identity is unknown is never assumed to
-- be the same account as another. The kept login keeps its own credential
-- and client.
--
-- In each group one login is kept: a working one first, then the one that
-- refreshed most recently (it refreshes with its own client, so this proves
-- that client still works), then the one with the most granted scopes, then
-- one that something else depends on, then the oldest. Another login merges into it only when the kept login has every
-- scope that one has, so nothing it could do is lost. Then its tool choices
-- join the kept login's (strictest wins), the kept login is turned on
-- wherever the merged one was, schedule pins and connectors and chat servers
-- naming it name the kept login, and the merged login is revoked with
-- metadata.mergedIntoConnectionId.
--
-- A login that an event trigger, vault, Knowledge sync, Site tool allowance,
-- API Integration or Slack agent depends on is never merged away; its person
-- removes it when they want to. Accepted turns, schedule runs and their audit
-- records keep the login they ran with.
--
-- Rolling: no schema change. The previous release reads the same rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- The migration principal is bound by FORCE ROW LEVEL SECURITY and has no
-- tenant settings, so every table read or written here is owner-visible only
-- for this transaction. The application role stays policy-bound. The tables
-- that keep a login from being merged must be visible too, or a dependency
-- would read as absent.
ALTER TABLE "connections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "connector_action_policies" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_grants" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_installations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_mcp_servers" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "event_sources" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "vaults" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_states" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_tool_allowances" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_facet_installations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_facet_bindings" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_slack_installs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_agent_intro_posts" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_agent_suggestions" NO FORCE ROW LEVEL SECURITY;

CREATE TEMPORARY TABLE merged_personal_logins (
  account_id uuid NOT NULL,
  duplicate_id uuid NOT NULL PRIMARY KEY,
  duplicate_authority_id uuid NOT NULL,
  survivor_id uuid NOT NULL,
  survivor_authority_id uuid NOT NULL,
  survivor_workspace_id uuid NOT NULL
) ON COMMIT DROP;

WITH login AS (
  SELECT connection.id, connection.account_id, connection.workspace_id,
         connection.owner_organization_membership_id, connection.authority_id,
         connection.status, connection.granted_scopes, connection.created_at,
         connection.last_refresh_at, connection.provider_domain,
         connection.metadata ->> 'mcpUrl' AS mcp_url,
         connection.metadata ->> 'authorizationServerIssuer' AS issuer,
         -- The verified identity tuple each service's verification records
         -- (apps/api/src/integrations/oauth-profiles.ts); string values only.
         CASE
           WHEN jsonb_typeof(connection.metadata -> 'slackTeamId') = 'string'
             AND jsonb_typeof(connection.metadata -> 'slackUserId') = 'string'
             AND connection.metadata ->> 'slackTeamId' <> ''
             AND connection.metadata ->> 'slackUserId' <> ''
             THEN jsonb_build_array('slack', connection.metadata ->> 'slackTeamId',
                                    connection.metadata ->> 'slackUserId')
           WHEN jsonb_typeof(connection.metadata -> 'gmailEmail') = 'string'
             AND connection.metadata ->> 'gmailEmail' <> ''
             THEN jsonb_build_array('gmail', connection.metadata ->> 'gmailEmail')
           WHEN jsonb_typeof(connection.metadata -> 'googleCalendarEmail') = 'string'
             AND connection.metadata ->> 'googleCalendarEmail' <> ''
             THEN jsonb_build_array('google_calendar',
                                    connection.metadata ->> 'googleCalendarEmail')
           WHEN jsonb_typeof(connection.metadata -> 'googleDriveEmail') = 'string'
             AND connection.metadata ->> 'googleDriveEmail' <> ''
             THEN jsonb_build_array('google_drive', connection.metadata ->> 'googleDriveEmail')
           WHEN jsonb_typeof(connection.metadata -> 'atlassianAccountId') = 'string'
             AND connection.metadata ->> 'atlassianAccountId' <> ''
             THEN jsonb_build_array('atlassian', connection.metadata ->> 'atlassianAccountId')
         END AS identity
  FROM connections connection
  WHERE connection.authority_scope = 'user'
    AND connection.authority_id IS NOT NULL
    AND connection.owner_organization_membership_id IS NOT NULL
    AND connection.subject_id IS NOT NULL
    AND connection.kind = 'oauth2'
    AND connection.status <> 'revoked'
    AND jsonb_typeof(connection.metadata -> 'mcpUrl') = 'string'
    AND jsonb_typeof(connection.granted_scopes) = 'array'
), grouped AS (
  SELECT login.*, count(*) OVER account AS logins
  FROM login
  WHERE login.identity IS NOT NULL
  WINDOW account AS (
    PARTITION BY login.account_id, login.owner_organization_membership_id,
                 login.provider_domain, login.mcp_url, login.issuer,
                 login.identity)
), duplicated AS (
  -- Only logins that have a duplicate are checked for what depends on them.
  SELECT grouped.*,
         (
           EXISTS (SELECT 1 FROM event_sources source
                   WHERE source.connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM vaults vault
                      WHERE vault.provider_connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM knowledge_source_sync_states sync
                      WHERE sync.connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM site_tool_allowances allowance
                      WHERE allowance.connection_id = grouped.id::text)
           OR EXISTS (SELECT 1 FROM capability_facet_installations facet
                      WHERE facet.connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM integration_facet_bindings binding
                      WHERE binding.connection_id = grouped.id)
           -- Slack agents added after 1226 hold rows tied to their login.
           OR EXISTS (SELECT 1 FROM agent_slack_installs install
                      WHERE install.connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM slack_agent_intro_posts intro
                      WHERE intro.connection_id = grouped.id)
           OR EXISTS (SELECT 1 FROM slack_agent_suggestions suggestion
                      WHERE suggestion.connection_id = grouped.id)
         ) AS depended_on
  FROM grouped
  WHERE grouped.logins > 1
), ranked AS (
  SELECT duplicated.*,
         row_number() OVER (
           PARTITION BY duplicated.account_id, duplicated.owner_organization_membership_id,
                        duplicated.provider_domain, duplicated.mcp_url, duplicated.issuer,
                        duplicated.identity
           -- A login refreshes with the OAuth client it was made with, so the
           -- one that refreshed most recently proves its client still works;
           -- an older client may since have been retired.
           ORDER BY (duplicated.status = 'active') DESC,
                    duplicated.last_refresh_at DESC NULLS LAST,
                    jsonb_array_length(duplicated.granted_scopes) DESC,
                    duplicated.depended_on DESC,
                    duplicated.created_at, duplicated.id) AS rank
  FROM duplicated
)
INSERT INTO merged_personal_logins (
  account_id, duplicate_id, duplicate_authority_id, survivor_id, survivor_authority_id,
  survivor_workspace_id
)
SELECT duplicate.account_id, duplicate.id, duplicate.authority_id, survivor.id,
       survivor.authority_id, survivor.workspace_id
FROM ranked duplicate
JOIN ranked survivor
  ON survivor.rank = 1
 AND survivor.account_id = duplicate.account_id
 AND survivor.owner_organization_membership_id = duplicate.owner_organization_membership_id
 AND survivor.provider_domain = duplicate.provider_domain
 AND survivor.mcp_url = duplicate.mcp_url
 AND survivor.issuer IS NOT DISTINCT FROM duplicate.issuer
 AND survivor.identity = duplicate.identity
WHERE duplicate.rank > 1
  AND NOT duplicate.depended_on
  AND survivor.granted_scopes @> duplicate.granted_scopes;

-- 1a. Where the kept login already has the choice in its own workspace, it
--     takes the strictest of all copies.
WITH copies AS (
  SELECT choice.id, merge.account_id, merge.survivor_id, merge.survivor_workspace_id,
         choice.server_id, choice.tool_name, choice.action_name, choice.policy,
         choice.updated_by_subject_id, choice.updated_at
  FROM connector_action_policies choice
  JOIN merged_personal_logins merge
    ON merge.account_id = choice.account_id
   AND merge.duplicate_id::text = choice.connection_id
  UNION ALL
  SELECT choice.id, survivor.account_id, survivor.survivor_id, survivor.survivor_workspace_id,
         choice.server_id, choice.tool_name, choice.action_name, choice.policy,
         choice.updated_by_subject_id, choice.updated_at
  FROM connector_action_policies choice
  JOIN (SELECT DISTINCT account_id, survivor_id, survivor_workspace_id
        FROM merged_personal_logins) survivor
    ON survivor.account_id = choice.account_id
   AND survivor.survivor_id::text = choice.connection_id
   AND survivor.survivor_workspace_id = choice.workspace_id
), ranked AS (
  SELECT copies.*,
         row_number() OVER (
           PARTITION BY account_id, survivor_id, server_id, tool_name, action_name
           ORDER BY CASE policy WHEN 'block' THEN 3 WHEN 'ask' THEN 2 ELSE 1 END DESC,
                    updated_at DESC, id) AS rank
  FROM copies
)
UPDATE connector_action_policies kept
SET policy = winner.policy,
    version = kept.version + 1,
    updated_by_subject_id = winner.updated_by_subject_id,
    updated_at = now()
FROM ranked winner
WHERE winner.rank = 1
  AND kept.account_id = winner.account_id
  AND kept.workspace_id = winner.survivor_workspace_id
  AND kept.connection_id = winner.survivor_id::text
  AND kept.server_id = winner.server_id
  AND kept.tool_name = winner.tool_name
  AND kept.action_name = winner.action_name
  AND kept.policy IS DISTINCT FROM winner.policy;

-- 1b. Where it doesn't, the strictest copy moves to the kept login.
WITH copies AS (
  SELECT choice.id, merge.account_id, merge.survivor_id, merge.survivor_workspace_id,
         choice.server_id, choice.tool_name, choice.action_name, choice.policy,
         choice.updated_at
  FROM connector_action_policies choice
  JOIN merged_personal_logins merge
    ON merge.account_id = choice.account_id
   AND merge.duplicate_id::text = choice.connection_id
), ranked AS (
  SELECT copies.*,
         row_number() OVER (
           PARTITION BY account_id, survivor_id, server_id, tool_name, action_name
           ORDER BY CASE policy WHEN 'block' THEN 3 WHEN 'ask' THEN 2 ELSE 1 END DESC,
                    updated_at DESC, id) AS rank
  FROM copies
)
UPDATE connector_action_policies moved
SET workspace_id = winner.survivor_workspace_id,
    connection_id = winner.survivor_id::text,
    version = moved.version + 1,
    updated_at = now()
FROM ranked winner
WHERE winner.rank = 1
  AND moved.id = winner.id
  AND NOT EXISTS (
    SELECT 1 FROM connector_action_policies kept
    WHERE kept.account_id = winner.account_id
      AND kept.workspace_id = winner.survivor_workspace_id
      AND kept.connection_id = winner.survivor_id::text
      AND kept.server_id = winner.server_id
      AND kept.tool_name = winner.tool_name
      AND kept.action_name = winner.action_name);

-- 1c. Every copy left on a merged login is now part of the kept login's.
DELETE FROM connector_action_policies choice
USING merged_personal_logins merge
WHERE merge.account_id = choice.account_id
  AND merge.duplicate_id::text = choice.connection_id;

-- 2. The kept login is turned on wherever a merged one was; the merged
--    login's turn-ons end with it.
INSERT INTO organization_user_resource_grants (
  account_id, authority_id, owner_organization_membership_id, workspace_id,
  session_id, action, mode, context, authority_epoch, generation, status
)
SELECT DISTINCT merge.account_id, merge.survivor_authority_id,
       turned_on.owner_organization_membership_id, turned_on.workspace_id,
       NULL::uuid, 'connection.use', 'always', 'workspace_shared', NULL::integer, 1, 'active'
FROM organization_user_resource_grants turned_on
JOIN merged_personal_logins merge
  ON merge.account_id = turned_on.account_id
 AND merge.duplicate_authority_id = turned_on.authority_id
WHERE turned_on.action = 'connection.use'
  AND turned_on.mode = 'always'
  AND turned_on.context = 'workspace_shared'
  AND turned_on.session_id IS NULL
  AND turned_on.status = 'active'
ON CONFLICT DO NOTHING;

UPDATE organization_user_resource_grants turned_on
SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
FROM merged_personal_logins merge
WHERE merge.account_id = turned_on.account_id
  AND merge.duplicate_authority_id = turned_on.authority_id
  AND turned_on.action = 'connection.use'
  AND turned_on.status = 'active';

-- 3. Live references name the kept login: schedule pins (each kept once, in
--    its first place), connector installations and chat servers.
--    Application writes to schedules hold the workspace's session-tenancy
--    fence, which a trigger checks. This transaction's table lock (taken by
--    NO FORCE above, held until commit) already excludes every concurrent
--    writer, so the check is off for this one statement.
ALTER TABLE "scheduled_tasks" DISABLE TRIGGER session_tenancy_workspace_fence;

UPDATE scheduled_tasks task
SET agent_config = jsonb_set(task.agent_config, '{pinnedAccounts}', (
      SELECT coalesce(jsonb_agg(pin ORDER BY first_place), '[]'::jsonb)
      FROM (
        SELECT pin, min(place) AS first_place
        FROM (
          SELECT CASE WHEN merge.survivor_id IS NULL THEN entry.value
                      ELSE jsonb_set(entry.value, '{connectionId}',
                                     to_jsonb(merge.survivor_id::text))
                 END AS pin,
                 entry.place
          FROM jsonb_array_elements(task.agent_config -> 'pinnedAccounts')
               WITH ORDINALITY AS entry(value, place)
          LEFT JOIN merged_personal_logins merge
            ON merge.account_id = task.account_id
           AND merge.duplicate_id::text = entry.value ->> 'connectionId'
        ) renamed
        GROUP BY pin
      ) kept
    )),
    updated_at = now()
WHERE jsonb_typeof(task.agent_config -> 'pinnedAccounts') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(task.agent_config -> 'pinnedAccounts') AS entry(value)
    JOIN merged_personal_logins merge
      ON merge.account_id = task.account_id
     AND merge.duplicate_id::text = entry.value ->> 'connectionId');

ALTER TABLE "scheduled_tasks" ENABLE TRIGGER session_tenancy_workspace_fence;

UPDATE capability_installations installation
SET config = jsonb_set(installation.config, '{connectionRef,connectionId}',
                       to_jsonb(merge.survivor_id::text)),
    updated_at = now()
FROM merged_personal_logins merge
WHERE merge.account_id = installation.account_id
  AND installation.config #>> '{connectionRef,connectionId}' = merge.duplicate_id::text;

UPDATE session_mcp_servers server
SET connection_ref = jsonb_set(server.connection_ref, '{connectionId}',
                               to_jsonb(merge.survivor_id::text))
FROM merged_personal_logins merge
WHERE merge.account_id = server.account_id
  AND server.connection_ref ->> 'connectionId' = merge.duplicate_id::text;

-- 4. The merged login is revoked, like a disconnect, and says where it went.
UPDATE connections connection
SET status = 'revoked',
    version = connection.version + 1,
    metadata = connection.metadata
      || jsonb_build_object('mergedIntoConnectionId', merge.survivor_id::text),
    updated_at = now()
FROM merged_personal_logins merge
WHERE merge.account_id = connection.account_id
  AND merge.duplicate_id = connection.id;

ALTER TABLE "slack_agent_suggestions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_agent_intro_posts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_slack_installs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "integration_facet_bindings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_facet_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_tool_allowances" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_source_sync_states" FORCE ROW LEVEL SECURITY;
ALTER TABLE "vaults" FORCE ROW LEVEL SECURITY;
ALTER TABLE "event_sources" FORCE ROW LEVEL SECURITY;
ALTER TABLE "session_mcp_servers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "capability_installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "scheduled_tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "organization_user_resource_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "connector_action_policies" FORCE ROW LEVEL SECURITY;
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
