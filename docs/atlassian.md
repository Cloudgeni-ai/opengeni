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

Most Atlassian tools require a `cloudId`. Opengeni fills it in from the
account's sites (`getAccessibleAtlassianResources`) through the generic account
parameters mechanism (see "Account parameters" in
[remote-mcp-credentials.md](remote-mcp-credentials.md)). With one site, models
can leave it out; with several, a call without it lists the sites to choose from.

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

The native read-only API/Knowledge-sync adapter was removed with integration
Knowledge sync (see [Knowledge](knowledge.md)). Its OAuth start, callback,
source browsing and selection are gone. The routes the public SDK still calls
(`browseAtlassianSources`, `saveAtlassianSources`, `setAtlassianLifecycle`) and
the `atlassian` Connect provider id answer 410 until the next SDK major. Hosted
MCP OAuth is independent and unchanged. Existing native credentials are never
converted into MCP grants; saved native connection rows are inert, are not
shown, and can still be revoked through the generic connection DELETE route.

The three historical first-party tools (`atlassian_sources_list`,
`atlassian_search`, `atlassian_get`) remain parseable in stored policies but are
absent from active tool catalogs and cannot acquire native execution authority.

Canonical implementation:

- Connect providers and accounts: `apps/api/src/routes/connect.ts`
- Hosted OAuth: `apps/api/src/integrations/oauth-client.ts`
- Active first-party catalog: `apps/api/src/mcp/server.ts`
- Historical tool names: `packages/contracts/src/atlassian-native-retirement.ts`
- Removed-route stubs: `apps/api/src/routes/connections.ts`
