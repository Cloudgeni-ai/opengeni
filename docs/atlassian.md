# Atlassian integration

Jira, Confluence, Jira Service Management, Bitbucket, Loom and Compass use
Atlassian's hosted MCP server. The curated connector uses Atlassian's v2 endpoint
with its flat tool list, `https://mcp.atlassian.com/v2/mcp?tools=all`, so every
tool has its own approval policy instead of shared discover and execute tools.
That query string is the one reviewed exception to the catalog's no-query rule
(`REVIEWED_QUERY_MCP_URLS` in `scripts/import-integrations-catalog.ts`).

The earlier `https://mcp.atlassian.com/v1/mcp/authv2` row stays in the catalog as
"Atlassian (v1)" so existing installations and connections keep working;
connections are bound to their exact MCP URL and a v1 token can't call v2, so the
two are separate resources and connecting v2 is a new connection. Atlassian
switches v1 connections to v2 tools on 1 March 2027. Atlassian plugins keep their
existing URLs. Users approve Atlassian access in the browser; Opengeni stores the
resulting connection through its encrypted connection broker and applies normal
tool permissions.
Hosted tools follow the connected user's Atlassian access and provider controls.
They do not use the former native project's or space's source selection.

## Organization admin: allow the Opengeni domain

Atlassian's Rovo MCP server only accepts OAuth connections from domains the
customer's Atlassian organization allows. Atlassian-supported domains are
allowed by default; Opengeni's domains are not on that list, so most
organizations must add the deployment's public origin before anyone can connect.
Without it, the Atlassian consent screen reports that an organization admin must
authorize access from the domain, and no connection is created.

An Atlassian organization admin adds it once for the whole organization:

1. Open Atlassian Administration at admin.atlassian.com and select the organization.
2. Go to **Rovo**, then **Rovo MCP server** (older consoles: **Apps**, **AI settings**,
   **Rovo MCP server**).
3. Under **Allowed domains** (or **Domain settings**), select **Add domain** and enter
   the deployment origin with a path wildcard, for example
   `https://app.opengeni.ai/**`. Embedded and self-hosted deployments use their own
   `OPENGENI_PUBLIC_BASE_URL` origin.
4. Optionally restrict Read, Write and Search per product on the same page.

If the error persists after saving, Atlassian's guidance is to remove the entry,
add the identical entry again, and retry in a fresh private window. Organizations
with an Atlassian IP allowlist must also allow Opengeni's egress addresses.
Removing the domain blocks new connections for the organization; existing grants
can be revoked from the organization's connected apps.

References: [Control Rovo MCP server settings](https://support.atlassian.com/rovo/docs/control-atlassian-rovo-mcp-server-settings/),
[OAuth consent block](https://support.atlassian.com/rovo/kb/fix-oauth-consent-block-for-atlassian-rovo-mcp-server-in-atlassian-cloud/).

The native read-only API/Knowledge-sync adapter is retired. It no longer appears
as a new Connect provider. Native OAuth start, source browsing/selection, live
reading and resume refuse execution. A pending native callback may settle its
saved Connect attempt as failed with `atlassian_native_retired`; it never
exchanges a code or commits a new grant. Hosted MCP OAuth is independent and
unchanged. Existing native credentials are not converted into MCP grants.

Historical native accounts show a retirement notice and retain disconnect.
Their three first-party tools (`atlassian_sources_list`, `atlassian_search`,
`atlassian_get`) remain parseable in historical policies but are absent from
active tool catalogs and cannot acquire or inherit native execution authority.

Existing native source schedules show **Sync retired** and do not admit new
agent runs. New native source schedules, manual triggering and resume are
refused. Queued historical runs settle before session dispatch; the worker no
longer contains a source fetch adapter. The `api.atlassian.com` source identity
only selects the Atlassian-specific retirement copy: every integration Knowledge
sync is retired (see [Knowledge](knowledge.md)), while hosted MCP schedules run
normally.

No migration deletes or transforms connections, grants, schedules, imported
Documents, source provenance, ACL records or audit history. Imported content
retains its existing authorization rules and is no longer refreshed from
Atlassian. Pause, disconnect and schedule deletion retain their existing cleanup
semantics, including retrieval deauthorization. The native deployment client
settings and wire types remain compatibility surfaces, not requirements for
hosted MCP.

Canonical implementation:

- Retirement identity/reason: `packages/contracts/src/atlassian-native-retirement.ts` and `packages/contracts/src/knowledge-source-sync-retirement.ts`
- Historical native routes and cleanup: `apps/api/src/integrations/atlassian.ts`
- Connect providers and accounts: `apps/api/src/routes/connect.ts`
- Hosted OAuth: `apps/api/src/integrations/oauth-client.ts`
- Active first-party catalog: `apps/api/src/mcp/server.ts`
- Native authority retirement: `packages/core/src/domain/personal-connection-delegations.ts`
- Schedule admission and retained-run guards: `packages/core/src/domain/scheduled-tasks.ts`, and `apps/worker/src/activities/scheduled-tasks.ts`
- Historical account UX: `apps/web/src/components/capabilities/use-atlassian-integration.tsx`
