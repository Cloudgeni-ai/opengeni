# MCP surfaces — which one do you want?

Audience: integrators. OpenGeni touches the Model Context Protocol in seven
places. They are different products with different owners and lifecycles; this
page exists so you pick the right one in one read.

| Surface | Who configures it | Scope / lifecycle | Credentials | Use it when |
| --- | --- | --- | --- | --- |
| **First-party OpenGeni MCP** (`/v1/workspaces/:id/mcp`) | Embedding host selects tool names per session | Always attached; the model sees the session's exact catalog selection intersected with its authorization grant | The caller's own bearer; internally delegated `ogd_` tokens carry permissions and the separate tool-name selection | An agent should use selected OpenGeni-native orchestration or self-management tools |
| **Codemode** (`/v1/workspaces/:id/codemode`) | OpenGeni worker, from the exact tools prepared for one attempt | Immutable attempt-frozen projection of every admitted model tool; approval-required entries remain visible but cannot execute programmatically | Exact `agent_attempt` bearer: protected renewable file in managed sandboxes; in-memory, per-exec snapshot on Connected Machines. Execution stays in the owning worker and reuses the same resolved credentials/executor as model MCP | Attempt code needs typed, idempotent tool calls without a model round trip |
| **Docs MCP** (`/mcp/docs`) | Nobody — built in | Built in; selected through the `docs` server ref | Caller's bearer | An agent should search the workspace's documents store |
| **Files MCP** (`/mcp/files`) | Nobody — built in | Default-on download-materialization surface selected through the `files` server ref; an explicit API policy may omit it | Caller's bearer with `files:read` | An agent needs a short-lived download URL for a ready file, including an original file identified by document search |
| **Capability MCP servers** | Workspace admin (capabilities settings) | Workspace-wide; on for every session while enabled | Workspace-owned OAuth or admin-supplied headers, authenticated-encrypted at rest; ordinary projections are metadata-only. Dedicated permissioned plaintext reads are an approved release-held follow-up. Gmail and Slack's hosted MCP are personal-only and never workspace-owned | A third-party tool (e.g. a SaaS MCP) should be available to *all* sessions and schedules in a workspace |
| **Per-session MCP servers** (`mcpServers` on session create) | The embedding host, per session | One session; static headers rotatable on every user turn; host connection refs resolved per request | Authenticated-encrypted headers with metadata-only ordinary projections, or a non-secret opaque `connectionRef` resolved by the standalone/host broker. Dedicated plaintext reads are an approved release-held follow-up | An embedding host injects its own tool server or binds an existing provider connection without duplicating it |
| **Codex Apps MCP** | Deployment enables the feature; a scoped human explicitly designates one workspace credential; session policy selects it | Available only while that exact designation remains authorized; workspace-default sessions receive it as optional, while explicit/fixed sessions see it only when selected | Only the designated Apps credential, independent of inference | A compatible model should use connected ChatGPT apps without tying their authority to inference routing or silently widening an exact tool allowlist |

First-party OpenGeni MCP memory tools:

- `memory_search` — search the workspace's shared long-lived memory with hybrid semantic + keyword retrieval.
- `memory_save` — save one durable, future-useful workspace memory through the deterministic write gate.
- `memory_correct` — archive or supersede an incorrect/outdated workspace memory by id.

These tools are session-scoped: they register only when the delegated bearer carries
a worker-signed `sessionId` claim and the workspace's `settings.memoryEnabled`
setting is true. The REST/UI memory audit and seed surfaces remain available when
the setting is off.

`CreateSessionRequest.firstPartyMcpTools` is an exact allowlist over the exported
`FIRST_PARTY_MCP_TOOL_NAMES` catalog. Omission selects the safe default catalog,
which excludes connector-wide `social_*`, `slack_bot_*`, `fiken_*`, and `atlassian_*` tools; those require
explicit selection plus their normal connection permission. Explicit `[]` means
no tools from the broad server. Unknown names fail validation. This field does
not grant authority: every catalog entry also has an explicit registration-time
permission predicate, and target-scoped authorization still runs on calls.
Child omission inherits the parent's exact effective selection.

GitHub App installation credentials are deliberately absent from this catalog.
Repository discovery and browser connect status remain model-visible, but token
minting and credential-file renewal stay host-side in the worker/runtime. No
first-party MCP, Codemode, API, SDK, event, or audit projection returns a live
installation token to the model or sandbox command surface.

File and document resources are independent from this broad-server selection.
Attaching a resource still materializes it for the session when
`firstPartyMcpTools` is `[]` or title-only; selecting the dedicated `files` or
`docs` MCP server is a separate `tools` decision. Document search results carry
the backing `fileId`; reading an indexed chunk stays within Docs MCP, while
downloading the complete original uses Files MCP. Workspace-default policy
includes Files, but an explicit API/embedding policy may omit it.

Codex Apps follows that same separation. Enabling
`OPENGENI_CODEX_CONNECTED_APPS_ENABLED` registers `codex_apps` as a selectable
runtime MCP only for workspaces with one explicit, currently authorized Apps
credential designation; the flag alone exposes no executable tools. Omitted
session tools use the workspace default and include it as optional. Explicit and
inherited-fixed policies remain exact. A null designation means no Apps server
and there is no active-credential, pinned-credential, allocator, or static-header
fallback.

When an Apps setup attempt fails, the runtime keeps the surface visible and
emits an Apps-specific reconnect/retry state instead of silently presenting an
empty tool-search pool. Statusless transport failures are marked retryable;
provider response bodies, URLs, headers, and credentials remain outside the
public diagnostic projection.

Inference and Apps authority are deliberately unrelated. The designated Apps
credential works with compatible Codex or non-Codex inference and remains usable
when every inference subscription is quota-exhausted, cooled down, allocator-
disabled, unpinned, or leased elsewhere. Only the current human owner of an
active connected credential may designate it, and that human must currently
hold `connections:write` (workspace-admin scope satisfies it). Any managed human
with that scope may clear the designation without owning the credential. Bearer,
agent, scheduled, and service identities cannot perform either mutation. Every
Apps request rechecks the exact designation, connection status, owner membership,
and owner permission immediately before resolving/sending credentials. Reconnect
never changes a credential's owner; disconnect clears the designation and audit
event atomically. Visibility still obeys the session tool policy independently.
Codex Apps tools admitted to an attempt are projected into Codemode from the
same frozen catalog. Codemode does not proxy or reconstruct them: execution
returns to the same prepared MCP instance, so the per-request designated-owner
check and connector-wire compatibility layer remain authoritative and no static
or weaker credential copy reaches sandbox code.

### Accepted connection-use authority

Organization-user connections are selected explicitly; a session creator,
current browser user, service actor, or worker identity is never a substitute.
For activated configured MCP connections, the accepted human/API turn stores a
server-built, credential-free snapshot of the exact connection, causal human,
organization membership authorization revision, common resource authority,
grant, target session visibility/epoch, and accepted logical work. Each
physical provider request—including a safe read retry after 401—must authorize
that persisted snapshot for the exact current attempt before resolving any
credential. A `once` grant is consumed atomically when the logical turn is
accepted and is bound to that turn by its durable receipt; every physical call
and recovery attempt only validates the matching receipt, while another turn
cannot be accepted with it. Audit facts contain identifiers, generations, outcome,
and a denial reason only—never credentials, headers, arguments, content, or
provider responses.

Migration 0264 is a drained maintenance cutover because an old worker can omit
these attempt/use facts. The migration enforces the drain with live app-role
session checks around exclusive writer locks and rejects all executable
pre-activation common-user work instead of backfilling it from mutable state.
Its first bounded activation covers configured remote
MCP, API-hosted OpenAPI/GraphQL, Gmail REST, and Google Drive publication
requests; the publication adapter reauthorizes
independently before destination verification, idempotency search, and upload,
and never replays an outcome-uncertain upload. Host credential callbacks are
limited here to host MCP credential callbacks: they are invoked only after local
authorization and receive credential-free attribution. Git, sandbox, and run
credential ports are separate authorities and are not covered by migration 0264.
Activated Atlassian is omitted from direct turns, and scheduled tasks reject
activated MCP, Google Drive, and Atlassian selections, until their dedicated
acceptance/occurrence adapters land. First-party Atlassian, Fiken, Slack,
social, and scheduled knowledge-source surfaces remain explicit successors;
workspace and `legacy_user` connections remain on their bounded compatibility
path rather than being silently upgraded.

An activated personal connection freezes its physical origin separately from
the target workspace. Exact common authority permits same-organization use and
the lifecycle-derived owner-only personal workspace even though that personal
workspace intentionally has no membership row. Workspace administrators,
other subjects, and cross-organization callers receive no corresponding
portable authority.

### Codex Apps designation parity verdict

- **Pelle/MCP:** the designated credential powers the direct model MCP. There is
  deliberately no Pelle mutation tool for choosing or clearing a human-owned
  credential; those actions require a same-origin managed-human browser session.
- **Search and command navigation:** this workspace setting is not indexed domain
  content. The existing Workspace settings route is its navigation surface; no
  separate command-palette action is warranted.
- **Event spine:** designation, clear, and disconnect-clear write secret-free audit
  events in the same transaction. They do not create session-history events or
  notifications because they are workspace configuration, not conversation work.
- **Mobile:** there is no native OpenGeni administration surface. The responsive
  Workspace settings card is the supported mobile web surface.
- **Permissions and SDK:** REST and SDK mutations enforce the same
  `connections:write` managed-human boundary; enable additionally requires exact
  credential ownership, while disable does not.
- **Export and public links:** neither plane exposes credential selection or token
  material. Workspace state export remains unchanged.
- **Legal/processing scope:** this reuses the existing user-authorized ChatGPT
  connection and existing Apps destination. It adds no personal-data category,
  purpose, recipient, retention behavior, or additional owner field.

Docs MCP also has a `memory_search`, but it is the curated documents surface, not
the first-party turn tool. It now reads both `active` and `approved` memory records
so the curated lane and Workspace Memory V1 share the same agent-visible set;
`memory_propose` still writes `proposed` records for human review.

Rules of thumb:

- Building a product **on top of** OpenGeni (embed or API)? Per-session MCP is
  your integration point for host tools; the first-party MCP is your agents'
  steering wheel.
- Giving **every** session in a workspace a tool? Capability MCP.
- Do not proxy one MCP surface through another. Codemode is not an exception:
  it projects the worker's already-prepared attempt catalog and dispatches back
  into those same executor closures.
- A broker may refresh credentials after an upstream 401 for future requests,
  but it retries the current request only for the explicit replay-safe JSON-RPC
  allowlist: `initialize`, `notifications/initialized`, and `tools/list`.
  Malformed bodies, unknown extensions, non-list methods, and any batch with an
  unsafe entry return secret-free outcome-uncertain error `40102` without a
  second physical request and instruct the caller to verify provider state.
- Embedded hosts that already own provider connections should bind
  `ConnectionCredentialsPort.mcpCredentials` on both the API and worker. The
  host's connection remains authoritative; the sandbox bearer is never treated
  as a second GitHub/GitLab/Azure identity.

Details: first-party tools and grants in [architecture.md](architecture.md),
first-party mutation receipts and read/action response classes in
[mcp-response-contracts.md](mcp-response-contracts.md),
per-session servers in [session-mcp-servers.md](session-mcp-servers.md),
workspace capabilities in [capabilities.md](capabilities.md), credential
handling in [credentials.md](credentials.md), and the full Codemode design in
[design/codemode.md](design/codemode.md).
