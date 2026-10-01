# Data tools and credentials

## Existing customer APIs can become agent tools

The customer does not need an MCP server when it already has a suitable HTTP or GraphQL API. Choose among these paths:

1. **OpenAPI Integration** — publish a focused OpenAPI 3.0 or 3.1 document for the operations the agent may use. OpenGeni deterministically compiles selected operations into agent tools.
2. **GraphQL Integration** — expose a bounded GraphQL endpoint when that is the product's canonical API shape.
3. **Remote MCP server** — use MCP when the customer wants an agent-oriented protocol, richer discovery, or compatibility with other agent clients.
4. **Narrow gateway** — add a small customer-owned API in front of legacy services, then describe that gateway with OpenAPI or MCP.

The OpenGeni SDK's createSession tools field selects MCP-style runtime capabilities. It does not accept arbitrary JavaScript, Python, Go, or C# callback functions from the customer's backend. Existing backend functions must be reachable through an authorized network API and one of the supported tool surfaces.

An installed API Integration and a remote MCP server are distinct control-plane resources even though both become model-callable tools at runtime. Preserve that distinction when explaining setup, IDs, credential lifecycle, and failures.

Do not create an MCP server merely to rename otherwise safe API endpoints. Do not expose a broad internal API merely because it already exists. Prefer the least new infrastructure that produces a clear, bounded, stable agent contract.

## Preserve meaning while reusing data access

Reuse the product's authorized query/business logic, but return the information
needed for the task rather than every field of a UI page. Prefer aggregate or
selected sections when row-level personal data adds no value. Keep optional
detail available through an appropriately scoped operation when the use case
needs it.

Describe definitions, units, denominators, applicable filters, observation windows
and freshness close to the tool schema or results. Distinguish all-time snapshots
from filtered series, optional product steps from required milestones, and missing
breakdowns from zero results. Context belongs in the data contract rather than a
large generic system prompt. Be explicit when a requested filter has no effect.
For analytical products, distinguish association from causation and label proposed
experiments as hypotheses. Add approved queries for missing analyses instead of
inventing results or exposing unrestricted database access.

## OpenAPI and GraphQL lifecycle

The normal workspace-scoped API Integration flow is deterministic control-plane work, not a model repeatedly reading and approving documentation:

1. Host the API description and provider endpoint where the OpenGeni control plane can reach them under the deployment's network policy.
2. Create or resolve the appropriate encrypted Connection when authentication is required. An `api_key` Connection must say where the secret goes: `credential: { headers: { Authorization: "Token ..." } }`, or `credential: { placements: [{ carrier: "header" | "query" | "cookie", name, value, prefix? }] }` (query and cookie placements work for API Integrations only). Match `preview.auth.carrier`/`name` from step 3; a bare `{ apiKey }` is rejected with 422, and preview adds a warning when the Connection's placement differs from the description.
3. Call previewApiIntegration with the source and, when needed, the Connection. The source can be a URL or an inline document: `{ kind: "openapi_document", sourceKey: "<stable id>", document: "<OpenAPI JSON/YAML>", baseUrl? }` (8 MiB max, absolute server URLs or `baseUrl`; resend it on install; the preview echoes only its digest). Inlining does not make a localhost or private API reachable: tool calls still follow the deployment network policy, so a local product needs a public tunnel.
4. Apply the customer's policy to the compiled operation list, safety classification, warnings, and approval modes. Select only intended operations.
5. Call installApiIntegration with the exact preview revision and content digest, Connection, stable instance key, and allowed operations. Write and destructive operations (preview `approvalMode: "ask"`) otherwise pause every call for human approval, which a scheduled or unattended run cannot give; list the ones your policy allows to run unattended in `autoApprovedTools` (`capabilities:manage`; custom and curated Integrations alike, except operations a curated definition explicitly keeps human-approved). Use the exact compiled identifiers from `preview.tools[].id`, not a guessed OpenAPI operationId or model-facing prefixed name. The field is declarative: an update that omits it makes every write tool ask again. MCP connector tool permissions and session `mcpApprovalPolicies` do not apply to API Integrations.
6. Persist the returned non-secret instance and server identifiers with the workspace provisioning record, then select that server for sessions: omit `tools` to follow the workspace defaults, or list it explicitly as `tools: [{ kind: "mcp", id: serverId }]`. An explicit `tools` array is an exact allow-list; `[]` selects no workspace server.

Preview and install are ordinary backend API calls and can be automated. Human review is required only when the customer's policy or the operation risk requires it. The immutable revision/digest fence ensures that automation cannot install a different schema from the one it evaluated.

Definitions, Connections, and installations are workspace-scoped. A per-user or per-chat workspace strategy may therefore need deterministic installation reconciliation for each workspace. Use a stable provisioning version and skip work that is already at the desired version; do not rediscover and reinstall on every chat request.

An agent-focused API description is often helpful: concise descriptions, stable operation identifiers, bounded schemas, server-side pagination, explicit read/write semantics, and no irrelevant administrative routes. It can describe existing endpoints rather than creating a second implementation.

## MCP lifecycle

A workspace MCP capability is suitable when many sessions in that workspace use the same server and authority. A session may also receive an explicit mcpServers definition with URL, allowed tools, approval policy, and write-only credential headers or a non-secret Connection reference.

For a per-session MCP server, `requireApproval: ["update_ticket"]` matches the
original tool name returned by the server's `tools/list`, not the model-facing
`acme__update_ticket` name (for server id `acme`). `true` gates every tool.
This MCP name list is distinct from an API Integration's compiled
`autoApprovedTools` identifiers; a session MCP policy does not override an API
Integration's install-time approval policy.

A server attached through a top-level createSession `mcpServers` entry is selected by that attachment, whether `tools` is omitted or explicit (including `tools: []`); there is no separate selection step. Every other MCP server (workspace capability, installed API Integration, deployment server) is reachable only when `tools` selects it or the omitted-`tools` workspace default includes it. A selected server the model never finds usually means it was not selected: check `session.effectiveToolPolicy`.

Selected MCP servers are prepared lazily by default: the model discovers their tools through `tool_search`. For a small, always-needed server (for example a product's own data tools), add `eager: true` to its ref, such as `tools: [{ kind: "mcp", id: "product", eager: true }]`, so its schemas are on the first model request. `eager` is a startup choice only and grants nothing. `optional: true` makes a connect or list failure skip that server instead of failing the demanding turn.

For session-specific MCP credentials, createSession stores header values encrypted and returns only metadata such as header names and credential version. Later accepted message requests can rotate those values through the supported MCP credential-update field without recreating the session. For workspace Connections, rotate or reconnect the Connection with optimistic versioning; installed Integrations continue to reference its stable ID.

Prefer short-lived, audience-bound tokens when the customer can issue them. Let the customer's authenticated backend mint or refresh a token for the exact product subject and data boundary. A workspace-wide credential is appropriate only when every session in that workspace may exercise the same provider authority.

## Product-owned repository credentials

For an automated job, use `client.asService(name, context?)` under a server-held
organization or workspace key, not a synthetic `asUser` identity. Service
attribution is not permission and grants no human/personal-resource authority.

Configure `putWorkspaceCredentialProvider` once during provisioning and store
the returned signing secret. The product's HTTPS endpoint verifies the exact
raw body with `verifyCredentialProviderRequest`, authorizes the signed
workspace/session scope independently of service labels, and returns short-lived
`git` credentials with an `expiresAt`. The provider, not a human's personal
Connection, owns those credentials.

Organization registration and secret rotation are focused server-side helpers,
not eager client methods:

```ts
import {
  putOrganizationCredentialProvider,
  createOrganizationWebhook,
  rotateOrganizationCredentialProviderSecret,
} from "@opengeni/sdk/workspace-integrations";

const { secret } = await putOrganizationCredentialProvider(client, organizationId, {
  url: "https://product.example/credentials",
  workspaceFilter: { externalSource: "product:production" },
});
await createOrganizationWebhook(client, organizationId, {
  url: "https://product.example/events",
  eventTypes: ["turn.completed"],
  workspaceFilter: { externalSource: "product:production" },
});
// Rotate explicitly when needed; store the new once-returned secret.
// await rotateOrganizationCredentialProviderSecret(client, organizationId);
```

All functions in `@opengeni/sdk/workspace-integrations` take `client` first.
This also covers organization reads/updates/deletes, webhook delivery listing
and redelivery, `getWorkspaceWebhook`, and both scopes' secret-rotation helpers.
Keep them on the product backend, never import them into the browser to expose
an organization key.

```ts
await client.asService("acme:reports", { jobId: jobRecord.id }).createSession(workspaceId, {
  initialMessage: "Summarize the latest report changes.",
  idempotencyKey: `reports:${jobRecord.id}`,
  resources: [{
    kind: "repository",
    uri: "https://gitlab.com/acme/reports.git",
    ref: "main",
    provider: "gitlab",
    access: "read",
  }],
  skills: productSkills,
  tools: [],
  firstPartyMcpTools: [],
  bundledSkillIds: [],
});
```

The credential-provider response supplies the `gitlab.com` host credential;
never put a token in the repository URI, Skill, context, or prompt. Repository
cloning requires managed compute. A Connected Machine owns its existing
checkout and Git authentication; OpenGeni neither clones repositories nor
injects Git tokens there. When source is available, see
`docs/workspace-integrations.md` for the signed protocol and
`docs/product-integration.md` for the full provisioning example.

## Where credentials are visible

For brokered API Integrations and MCP connections:

- plaintext credentials enter a trusted OpenGeni API boundary and are encrypted at rest under the deployment's configured key;
- API responses, session events, and model-visible tool definitions expose metadata, not the secret value;
- the trusted control plane decrypts the credential only to construct an authorized outbound request to the selected provider destination; and
- the model and sandbox receive the tool schema and bounded tool result, not the credential itself.

This is credential brokerage, not zero-knowledge storage. OpenGeni operators with the deployment encryption authority are in the trusted computing base. A provider could still echo secrets in an unsafe response, so customer endpoints must never return credentials and OpenGeni tool results should remain bounded and reviewed.

Do not put tokens in an OpenAPI document URL, MCP URL, prompt, modelContext, Skill, browser response, or log. Use Connections, write-only MCP headers, a supported OAuth flow, or the customer's secret manager.

During setup, inspect credential presence and selected account metadata without
printing secret values. Some CLI account/configuration commands return cached
tokens; check their output contract and select safe fields before emitting tool
output. A diagnostic or handoff should contain configuration names and checks,
not credentials. If exposure occurs, stop further disclosure and arrange revocation
or rotation through the authorized owner.

## Authorization belongs at every layer

Tool selection is not data authorization. The customer API must validate the presented credential on every operation and derive or verify the allowed tenant, user, report, and row scope. Do not trust model-supplied tenant IDs. Prefer endpoints whose server derives scope from token claims; when an ID is accepted, verify it belongs to those claims.

Separate operations by risk. Read-only analytics, data export, saved-report mutation, and administrative actions should not share an unnecessarily broad token or approval policy. Keep destructive or consequential writes absent or approval-gated unless the customer explicitly wants autonomous writes.

For analytics, return structured, bounded data with clear units, time zones, filters, pagination, and aggregation semantics. Provide server-side aggregates where practical. The agent may combine tool calls or use CodeMode to transform authorized results without placing every intermediate row in conversational context. Code execution happens in the selected OpenGeni sandbox or Connected Machine; provider credentials remain in the broker. Confirm that the installed tool surface is available to CodeMode before relying on that optimization.

## Rotation and failure

Design rotation before launch:

- keep Connection or session-server identifiers as non-secret references;
- update the encrypted credential under optimistic version or idempotency control;
- retry reads only when provider semantics make replay safe;
- never replay a write after an ambiguous provider acceptance;
- surface reauthentication as product state; and
- revoke the old provider credential after the new path is verified.

Test expiry, revocation, insufficient scope, wrong audience, wrong tenant, provider timeout, schema drift, and an ambiguous write outcome. A successful happy-path query does not prove a safe data integration.
