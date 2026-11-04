# `@opengeni/capabilities`

Protocol-neutral integration compilation for Opengeni. Immutable OpenAPI and
GraphQL revisions are compiled into local `MCPServer` implementations so they
use the existing lazy tool router, session policy, approval, auth-needed,
Toolspace, child-session, and scheduled-task paths.

The package owns protocol parsing and invocation only. Connection persistence,
credential encryption, tenant authority, operation receipts, and catalog
lifecycle stay in Opengeni's core/database layers.

Security defaults:

- credentials are resolved for one exact destination and verified before use;
- header, query, and cookie placements are bounded and validated atomically;
- curated Google/Microsoft Integration Definition OAuth stays in the normal encrypted Connection spine;
- redirects are never followed on credential-bearing requests;
- response bodies, schemas, operation counts, and deadlines are bounded;
- mutating operations are marked approval-required by default;
- a safe read/query may refresh and retry exactly once on `401`, while a
  mutation is never replayed after an ambiguous provider authorization result;
  and
- errors contain structural recovery facts, never provider bodies or secrets.

## Local MCP bridge kit

`src/mcp-bridge.ts` defines the shared contract for provider APIs exposed as
in-process MCP servers. A bridge declares a secret-free catalog identity,
actual authority class, reviewed tool-surface class, 1-32 exact HTTPS
destinations, and the safe-read-only replay rule. Adapter matching is generic
and fails closed on ambiguity. The descriptor is not authorization: each
adapter still revalidates its Connection or host-owned authority before every
provider request.

The Gmail REST adapter is the static reviewed example. OpenAPI and GraphQL
Integration Definitions keep their existing local MCP adapters without
claiming this descriptor. Google Drive remains one functional Integration row
with its existing Connection and facet authority. See
`docs/design/first-party-mcp-bridges.md`.

## Curated Microsoft Graph schemas

Microsoft definitions explicitly use `provider_validated_json`: JSON request
bodies remain JSON values, and Graph validates their fields. Path/query/header
schemas, required bodies, media types, scopes, destinations and write approvals
are retained. Binary/text body schemas are retained. Optional response schemas
are omitted because the adapter returns an HTTP-result envelope. This avoids
expanding Graph's recursive entity graph into every operation. Custom OpenAPI
sources retain their full schema compilation. The mode participates in the
immutable revision digest; preview refuses revisions above the persistence bound.

Contacts uses delegated `People.Read` for `/me/people`. OneDrive uses
`Files.ReadWrite.All` and excludes the organization-only followed-sites API;
neither requires organization-wide people or SharePoint permissions merely to
connect a personal Microsoft account.

SharePoint is its own work/school definition (`microsoft-sharepoint`) on the
`organizations` endpoint with delegated `Sites.ReadWrite.All`, so OneDrive keeps
working for personal accounts. It admits an exact reviewed allowlist: site search
and lookup, followed sites, subsites, document libraries and their files, lists
and list items (create and update need review), site pages, and Microsoft Search
(`POST /search/query`). No site, list, page or permission administration is
admitted.

Colleague lookup is shared by the work/school definitions: SharePoint and Teams
both admit read-only `/users` search (`$search` with the `ConsistencyLevel:
eventual` header), `/users/{user-id}`, `/users/{user-id}/directReports` and
`/me/directReports`. SharePoint requests `User.ReadBasic.All` (user consent;
basic profiles only). Teams, which already needs administrator consent, requests
`User.Read.All`, so profiles include job title and department, and it also
admits `/users/{user-id}/manager` and `/me/manager`: Microsoft requires
`User.Read.All` for any manager lookup. Outlook Contacts stays on the `common`
endpoint without directory permissions, so personal accounts can still connect.

Teams also admits `POST /search/query` as a reviewed read restricted to the
`chatMessage` entity type: the same Microsoft Search index as the Teams search box,
scoped to messages the signed-in person can see. Adding `User.Read.All` means
existing Teams connections must reconnect, with administrator consent, before the
directory tools work.

A reviewed allowlist entry may set `readOnly: true` for a provider action that
only reads despite its HTTP method, such as `POST /search/query`. The definition
passes these as `readOnlyOperations` to `compileOpenApiRevision`; provider
documents and custom APIs cannot relax the method's safety default themselves.
An entry's `description` replaces the provider's generic text with reviewed
guidance for the agent.

OpenAPI query arrays declared with `style: form` (also the query default) and
`explode: false` serialize as one comma-separated parameter, including Graph
`$select`, `$expand`, and `$orderby`. Default or explicitly exploded arrays keep
repeated parameter names. The corrected bindings receive a new immutable revision
identity. Refresh an existing integration catalog to adopt them; already accepted
revisions retain their original bindings and behavior.
