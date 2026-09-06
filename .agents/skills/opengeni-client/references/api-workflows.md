# OpenGeni API Workflows

This reference is intentionally pattern-level. Check the live service or source
contracts for exact schemas before generating SDK code. When the repository is
available, `docs/product-integration.md` is the canonical organization-key,
workspace-mapping, and Skill-ownership guide.

## Access Setup

Choose one credential deliberately:

- Managed SaaS product integration: create an organization API key through
  `POST /v1/organizations/:organizationId/api-keys` /
  `createOrganizationApiKey`, store the one-time token on the product server,
  and send `Authorization: Bearer <api-key>`.
- One-workspace automation: use a workspace API key and do not call
  organization provisioning routes.
- User/workspace delegation: use a short-lived delegated token with explicit
  authority rather than a standing organization key.
- Configured/self-hosted perimeter: a deployment access key may gate the
  deployment, but it is not tenant identity.
- Local development: the service may resolve a default dev subject/workspace without external auth.

Only add `x-opengeni-access-key` when the operator says the deployment
shared-key boundary is enabled. It is not a replacement for organization API
keys in managed SaaS.

## Minimal Server-Side Session Client

```ts
import { OpenGeniClient } from "@opengeni/sdk";

const client = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_ORGANIZATION_API_KEY!,
});

const organizationId = process.env.OPENGENI_ORGANIZATION_ID!;
const { workspace } = await client.ensureWorkspace({
  accountId: organizationId,
  externalSource: "acme-product",
  externalId: productTenant.id,
  name: productTenant.displayName,
});
if (workspace.kind !== "shared") {
  throw new Error("Product integrations require an organization workspace");
}

const skills = await productSkillStore.resolveForSession(productTenant.id);
const created = await client.createSession(workspace.id, {
  initialMessage: "Inspect the uploaded logs and summarize the failing deploy step.",
  idempotencyKey: crypto.randomUUID(),
  skills,
  firstPartyMcpTools: selectedFirstPartyTools,
  tools: selectedIntegrationServers,
});

for await (const event of client.streamEvents(workspace.id, created.id)) {
  if (event.type === "agent.message.delta") {
    process.stdout.write((event.payload as { text?: string }).text ?? "");
  }
}
```

This code belongs on the product server, not in a browser bundle. For a browser
timeline, expose a tenant-scoped same-origin route and use the SDK's
`proxySessionEventStream` helper. Authenticate the product user and resolve the
allowed workspace/session before opening the upstream stream.

`ensureWorkspace` maps through `PUT /v1/workspaces/external`. Use a stable
external source/id pair and persist the returned opaque id. The returned
organization workspace has wire `kind: "shared"`. Personal workspaces are
excluded; do not fall back to `/v1/access/me`'s default/personal workspace.
The method returns `{ workspace, created }`; use `workspace.id`, and treat
`created: false` as the normal idempotent replay result.

The product backend stores and versions Skills outside OpenGeni and passes the
selected definitions inline in `CreateSessionRequest.skills`. There is no
organization-wide Skill registry or Skill inheritance in this integration
contract.

The product must choose the workspace mapping from its sharing rule before
running this flow. A tenant-shared workspace is suitable only when that tenant
may share workspace-scoped agent authority and resources. Use a per-user
workspace for cross-user chat privacy and a per-chat workspace for hard
same-user chat isolation. `memoryEnabled: false` does not create either
boundary.

For a headless product, send an explicit minimal `firstPartyMcpTools` and
`tools` selection. Omission inherits deployment/workspace defaults. Removing
cross-session tools from a shared workspace is defense in depth, not a hard
tenant boundary.

## Existing APIs As Agent Tools

The SDK cannot serialize ordinary customer backend functions into tools. Use
one of the supported network boundaries:

- For an existing HTTP API, host a focused OpenAPI 3.0/3.1 document and call
  `previewApiIntegration`, then `installApiIntegration` with the exact revision,
  digest, Connection, stable instance key, and selected operations.
- For GraphQL, use the same preview/install lifecycle with the GraphQL source.
- For MCP, install a workspace capability or pass a session-specific
  `mcpServers` definition with an HTTPS URL, allowed tools, approval policy, and
  write-only headers or a `connectionRef`.

Preview/install is deterministic backend work and can be reconciled across many
workspaces; a model does not need to read and approve the same API description
for every workspace. Persist the returned Integration instance/server IDs and
skip unchanged desired versions rather than reinstalling on every chat.

Create API-key credentials with `createConnection`. Rotate ordinary credentials
through `updateConnection` with `expectedVersion`; OAuth providers use their
dedicated reconnect flow. For session-specific MCP headers, later message
requests may carry the supported MCP credential update. Responses expose
metadata and credential versions, never the values.

OpenGeni encrypts brokered credentials at rest and keeps them out of model
context. The trusted control plane can decrypt them to call the exact provider;
the model and sandbox receive only schemas and bounded results. The provider API
must still enforce tenant/user scope on every operation and must not trust a
model-supplied tenant ID.

## Runtime Profile And Models

Use workspace `agentInstructions` for stable workspace behavior, session
`instructions` for one role/conversation, Skills for conditional procedures,
and `modelContext` for current dashboard or route state. Avoid duplicating one
policy across all four surfaces.

Inline Skills are transmitted once in `createSession` and fixed onto that
session, not sent on each turn. Version the customer-owned runtime profile and
apply new Skill content to new sessions unless the product deliberately
migrates old ones.

Workspace `sessionDefaults` set the default model and reasoning for new
sessions. A session or message may override them subject to the workspace model
access policy. Resolve model IDs from the live client configuration rather than
hard-coding a remembered list.

OpenGeni-credit models in every organization workspace draw from the same
organization account balance; workspace creation does not create separate
wallets. Connected subscriptions and workspace-owned provider credentials may
instead use an externally billed path. Preserve the workspace and product
boundary in usage attribution when the customer needs a per-user or per-tenant
view over the shared organization balance.

Reconcile stable workspace settings, Connections, Integrations, and runtime
profile versions during provisioning, startup, deployment, or a controlled
migration. Do not PATCH the same settings or reinstall the same Integration on
every chat request when no desired version changed.

## Session Creation Options

Beyond `initialMessage`/`tools`/`resources`, the create body (`POST /v1/workspaces/:workspaceId/sessions`, the SDK's `createSession(workspaceId, request)`) chooses where the session runs:

- `sandboxBackend` — pick the managed sandbox execution backend; omit for the deployment default.
- `targetSandboxId` (uuid) — run the session on an enrolled **Connected Machine** (a user-owned machine) instead of a managed sandbox. It seeds the session's active-sandbox pointer at creation so the first turn routes to that machine; an invalid/unowned/offline target fails the create.
- `workingDir` — the host path the machine runs the session under (the base for its agent cwd, terminal, and file dock). **Only valid together with `targetSandboxId`** — sending `workingDir` alone is a 422. Omit it to use the machine's default working directory.
- `sandbox` — shared-sandbox placement for managed sandboxes, a three-way union: `"shared"` (join the creating session's box; a top-level `"shared"` is a 422), `"new"` (mint a fresh box), or `{ groupId }` (join a specific sibling group in the same workspace). Omitted resolves a context-dependent default server-side.
- `idempotencyKey` (1–200 chars) — a workspace-scoped CREATE idempotency key (see below).

`targetSandboxId`/`workingDir` are the managed-sandbox-vs-Connected-Machine choice; `sandboxBackend` and the `sandbox` placement union only apply to managed sandboxes. To move a session onto a different machine *after* creation, use the active-sandbox swap (below) — not `updateSession`, whose only field is the session `title`.

## Replay And Retry

- Persist the latest event sequence seen by the client.
- On reconnect, list events after the last known sequence before reopening the stream.
- Retry idempotent reads and stream reconnects with bounded backoff.
- Session creation exposes a workspace-scoped `idempotencyKey` (distinct from the per-call `clientEventId`): forward a stable value so concurrent/retried creates of the same logical session collapse to a single session. Without it every create is independent, so a blind retry can double-create — keep sending a stable key when you retry.
- Treat unknown event types as extensible timeline entries, not client crashes.

## Files

The usual flow is:

1. `POST /v1/workspaces/:workspaceId/files/uploads`
2. `PUT` bytes to the returned signed object-storage URL with the required headers.
3. Complete the upload through the returned workspace upload endpoint.
4. Attach the file resource to a session, follow-up turn, or scheduled task only after it is ready.

Never attach a file id from another workspace. Correct behavior is no data leak: 403 when the credential has no workspace grant, 404 when the resource is not in the granted workspace.

## Documents And Search

Use document bases when the product needs indexed/searchable knowledge rather than one-off file attachments. Create or select a base, add documents from uploaded files/text, wait for indexing, then use either the search route or a configured document-search MCP tool.

## GitHub Repositories

For private repos, use the workspace GitHub repository list before attaching a resource. A valid repository resource normally includes clone URL, ref, mount path, GitHub installation id, and GitHub repository id from OpenGeni's listing response. The worker mints short-lived GitHub App tokens for selected repositories and should not persist clone credentials in session manifests.

Do not ask customers to paste GitHub App private keys into their client integration. Managed SaaS uses the OpenGeni-owned app; self-hosted operators configure their own app server-side.

## Connected Machines And Enrollment

A Connected Machine is a user-owned machine enrolled into a workspace and used as first-class primary compute (no cloud box behind it; it uses its own git auth; repos are not cloned onto it). `selfhosted` is the internal `sandboxBackend` enum value for such a machine.

Discover and target machines:

- `GET /v1/workspaces/:workspaceId/machines` — list the workspace's machines (each with its derived state, latest metrics, and shared-session count) plus the active-sandbox pointer. Pass `?sessionId=` for an in-session view that also includes the session's own group box. SDK: `listMachines(workspaceId, { sessionId })`.
- `GET /v1/workspaces/:workspaceId/machines/:enrollmentId/metrics/series?window=15m|1h|6h|24h` — the downsampled (~1/min) metrics history. SDK: `machineMetricsSeries(workspaceId, enrollmentId, { window })`.
- Create a session with `targetSandboxId` (a machine's `sandboxId` from the list) plus an optional `workingDir` to run on it.
- `POST /v1/workspaces/:workspaceId/sessions/:sessionId/active-sandbox` with `{ target }` — swap the session's active sandbox mid-conversation; `target` is a machine's `sandboxId`, or `"session"`/`"default"` to return to the session's own group box. The response echoes `swapped`, `activeSandboxId`, `activeEpoch`, and a `reason` when a target is refused. SDK: `swapActiveSandbox(workspaceId, sessionId, { target })`.

Enroll a machine (the client-driven parts):

- Interactive device flow: the machine's own agent starts and polls the flow agent-side (unauthenticated). A workspace operator resolves the pending request by user code with `POST /v1/enrollments/device/lookup` (no workspace in the path — the server resolves it from the code, then authorizes `enrollments:read`), then `POST /v1/workspaces/:workspaceId/enrollments/device/approve` (the loud consent step; `allowScreenControl` opts into screen control) or `.../device/deny`. SDK: `lookupDeviceEnrollment(userCode)`, `approveDeviceEnrollment(workspaceId, { userCode, allowScreenControl })`, `denyDeviceEnrollment(workspaceId, { userCode })`.
- Headless / fleet: `POST /v1/workspaces/:workspaceId/enrollments/token` mints a short-TTL SECRET enroll token (surface it once with a copy-now warning); the machine's agent redeems it agent-side at `POST /v1/enrollments/token/exchange`. SDK: `mintEnrollToken(workspaceId, { allowScreenControl })`.
- `POST /v1/workspaces/:workspaceId/enrollments/:enrollmentId/revoke` removes a machine. Approving, minting, and revoking all require `enrollments:manage`; listing needs `enrollments:read`.

Never distribute an OpenGeni credential to a Connected Machine or try to inject git tokens into it — the machine authenticates to git with its own credentials. Device start/poll and token exchange are agent-side calls, not client SDK methods.

## Billing And Limits

Managed SaaS uses prepaid Stripe credits and local usage/cost accounting. Client behavior should be simple:

- Show billing/credit status from `/v1/billing` when the user has billing permission.
- Stop costly writes/runs when the API returns a credit/limit denial.
- Preserve read/export paths when writes are blocked.
- Surface top-up links from OpenGeni; do not call Stripe directly from a customer agent unless OpenGeni explicitly returns a Stripe URL.

## Generated Customer Skills

When generating a customer-specific agent skill that teaches their coding agents how to call OpenGeni:

- Include only their non-secret base URL, organization-workspace mapping
  convention, and safe API examples.
- Tell the agent to read API keys from the customer's secret manager or environment, never from the skill.
- State that the backend uses an organization API key, organization workspaces
  have wire `kind: "shared"`, and Personal workspaces are excluded.
- State where the external product stores Skills and that it passes selected
  definitions inline per session; never invent an organization-wide Skill
  registry or inheritance layer.
- Keep the skill versioned with their integration code and add a quick smoke command that calls `/v1/config/client` and `/v1/access/me`.
- State which integration shape the product chose and where its tenant-safe
  proxy/client lives; do not teach every possible shape in every customer skill.
- Describe only primitives proven by the installed SDK and live deployment; do
  not turn roadmap assumptions into customer instructions.
- Start from `customer-skill-template.md` in this directory so the generated
  skill records the chosen shape and smoke probes without copying credentials.
