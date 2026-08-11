# Atlassian integration

OpenGeni's Atlassian integration is a read-only Jira Cloud and Confluence Cloud adapter. It has two independent data paths so fresh provider state remains available without making the knowledge index the source of truth.

## Product behavior

- A subject connects one Atlassian account with OAuth 2.0 (3LO). The callback discovers every Jira or Confluence Cloud site currently available to that account.
- Capabilities shows one compact Atlassian card. **Manage** lists projects and spaces grouped by site, supports search, and lets the subject select sources.
- Selected projects and spaces are immediately eligible for live agent reads. Knowledge synchronization is a separate, optional switch and is off by default.
- V1 is read-only. It never creates, edits, comments on, transitions, or deletes Jira or Confluence content.

## Live agent access

The first-party MCP catalog contains three explicit-only tools:

- `atlassian_sources_list` discovers currently visible Jira projects and Confluence spaces and marks selected sources.
- `atlassian_search` searches current Jira issues or Confluence pages inside selected projects and spaces.
- `atlassian_get` opens a full issue or page, including comments, from a selected source.

These tools resolve the exact personal connection delegation frozen onto the accepted turn. Runtime use revalidates the connection owner, workspace membership, active state, provider, and credential kind. Tool arguments cannot choose a connection or expand the selected source boundary. Live reads call Atlassian directly and do not depend on synchronized Documents.

## Optional knowledge synchronization

When synchronization is enabled for a selected project or space, the existing provider-neutral `knowledge_source_sync` schedule and Temporal workflow own cadence, leases, buffering, retry truth, lifecycle generations, Documents authority, ACL eligibility, and indexing obligations.

The Atlassian driver supplies only provider behavior:

- Jira inventory uses enhanced issue search; content fetch includes issue fields and paginated comments.
- Confluence inventory uses the v2 pages endpoint scoped to the selected space; content fetch includes storage-format body content and paginated footer comments.
- Stable identities bind the Atlassian cloud id, source kind, selected source, and external issue/page id.
- Partial or failed inventories checkpoint and never infer deletion. Only a complete authoritative scan may tombstone an absent object.

Synchronized content becomes ordinary governed Documents/RAG evidence under the selected organization, workspace, or personal authority. It is not conversation history, Memory, policy, or automatic prompt content.

## OAuth and lifecycle

The server-side OAuth flow uses signed single-use callback state and an exact account/workspace/subject grant recheck. Reconnect must retain the same Atlassian account identity. Credentials are encrypted at rest; refresh requests use Atlassian's JSON token exchange and retain rotating refresh tokens. Pause, resume, reconnect, disconnect, source selection, and refresh all share the connection version boundary.

Required deployment settings:

- `OPENGENI_ATLASSIAN_CLIENT_ID`
- `OPENGENI_ATLASSIAN_CLIENT_SECRET`
- Callback: `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/atlassian/callback`

The Atlassian developer app must register the exact callback and grant the read scopes declared by `ATLASSIAN_REQUIRED_SCOPES` in `packages/contracts/src/atlassian.ts`.

This developer-app registration is deployment-wide operator setup. OpenGeni customers never create an Atlassian app or supply OAuth credentials: they click **Connect**, approve read access, then choose the Jira projects and Confluence spaces OpenGeni may use.

## Canonical implementation

- Wire contract: `packages/contracts/src/atlassian.ts`
- Provider-neutral normalization: `packages/documents/src/atlassian.ts`
- OAuth, browse, lifecycle, and live reads: `apps/api/src/integrations/atlassian.ts`
- HTTP routes: `apps/api/src/routes/connections.ts`
- Agent tools: `apps/api/src/mcp/server.ts`
- Frozen personal authority: `packages/core/src/domain/personal-connection-delegations.ts`
- Scheduled inventory/content driver: `apps/worker/src/activities/knowledge-source-sync.ts`
- Capabilities UX: `apps/web/src/components/capabilities/atlassian-connector-card.tsx`
