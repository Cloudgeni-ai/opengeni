# Atlassian integration

Jira and Confluence use Atlassian's hosted MCP server. The curated connector and
Atlassian plugins retain their existing URLs and ordinary MCP OAuth flow. Users
approve Atlassian access in the browser; OpenGeni stores the resulting connection
through its encrypted connection broker and applies normal tool permissions.
Hosted tools follow the connected user's Atlassian access and provider controls.
They do not use the former native project's or space's source selection.

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
refused. Queued historical runs settle before session dispatch; already accepted
source attempts cannot advertise or invoke the native fetch adapter. The checks
match the native `api.atlassian.com` source identity, preserving hosted MCP and
Google Drive schedules.

No migration deletes or transforms connections, grants, schedules, imported
Documents, source provenance, ACL records or audit history. Imported content
retains its existing authorization rules and is no longer refreshed from
Atlassian. Pause, disconnect and schedule deletion retain their existing cleanup
semantics, including retrieval deauthorization. The native deployment client
settings and wire types remain compatibility surfaces, not requirements for
hosted MCP.

Canonical implementation:

- Retirement identity/reason: `packages/contracts/src/atlassian-native-retirement.ts`
- Historical native routes and cleanup: `apps/api/src/integrations/atlassian.ts`
- Connect providers and accounts: `apps/api/src/routes/connect.ts`
- Hosted OAuth: `apps/api/src/integrations/oauth-client.ts`
- Active first-party catalog: `apps/api/src/mcp/server.ts`
- Native authority retirement: `packages/core/src/domain/personal-connection-delegations.ts`
- Schedule admission and retained-run guards: `packages/core/src/domain/scheduled-tasks.ts`, `apps/worker/src/activities/scheduled-tasks.ts`, and `apps/worker/src/activities/knowledge-source-sync.ts`
- Historical account UX: `apps/web/src/components/capabilities/use-atlassian-integration.tsx`
