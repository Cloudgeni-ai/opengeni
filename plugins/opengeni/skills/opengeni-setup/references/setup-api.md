# Setup: exact REST and SDK calls

Sections follow the setup skill's order: key, a verified chat, then product
tools; background work, callbacks and budgets only when requested. The coding
agent uses ordinary HTTPS and its own computer, or the `opengeni` MCP tools
when available (`opengeni_action_call` runs these same routes as the signed-in
user). Requests below are checked against `apps/api/src/routes` and
`packages/contracts` in this release. [setup-sdk.ts](setup-sdk.ts) provides
corresponding SDK calls and verification.

The canonical product agent, used in every recipe below, is:

```json
{"agent":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none"},"sandboxBackend":"none"}
```

`capabilities: "none"` keeps only the session's own tools plus asking the
user: no Opengeni workspace tools, connectors or bundled Opengeni guides.
Empty `tools`, `firstPartyMcpTools` or `bundledSkillIds` lists add nothing to
it. The renderer defaults to `"opengeni"`; send `"renderer":"markdown"` only
for a UI that renders plain Markdown.

## Environment and curl helper

Put these server-only variables in the product's `.env`, preserving unrelated
values:

```dotenv
OPENGENI_API_KEY=<organization API key>
# Optional: OPENGENI_API_BASE_URL defaults to https://app.opengeni.ai.
```

```bash
OPENGENI_API_BASE_URL="${OPENGENI_API_BASE_URL:-https://app.opengeni.ai}"
mkdir -p .opengeni-setup # request/response JSON files for the steps below
ogcurl() { # ogcurl METHOD PATH [JSON_BODY_FILE] [OUTPUT_FILE]
  curl --silent --show-error --fail-with-body -X "$1" "$OPENGENI_API_BASE_URL$2" \
    -H "Authorization: Bearer $OPENGENI_API_KEY" \
    ${3:+-H 'Content-Type: application/json' --data-binary "@$3"} ${4:+-o "$4"}
}
```

Public bootstrap before a key exists:

```bash
curl --fail --silent --show-error "$OPENGENI_API_BASE_URL/v1/config/client"
```

SDK: `new OpenGeniClient({ apiKey })` (base URL defaults to production),
`getClientConfig()`, `getAccessContext()`.

## 1. Organization and key

Sign in (or connect the Opengeni MCP tools), then complete the
organization-name onboarding or reuse the intended organization. Organization
keys live in Organization settings → Developer; workspace settings → API keys is
the wrong scope for setup. Create a **Full access** key with a 30-day expiry.

API / MCP equivalent: `POST /v1/organizations/:organizationId/api-keys`
(MCP action `createOrganizationApiKey`) with

```json
{"name":"Product setup","access":"full","expiresAt":"<now + 30 days, ISO 8601>"}
```

SDK: `createOrganizationApiKey(organizationId, { name, access: "full", expiresAt })`.
The response's `token` is the key; put it in `.env` as `OPENGENI_API_KEY`.

The limited `developer_setup` tier holds only `workspace:create`,
`workspace:admin` and `usage_allowances:manage` (24-hour default expiry); it
cannot manage keys. Budget writes need the organization key itself, not an
`asUser` client or a session credential.

Verify: `ogcurl GET /v1/access/me` shows `credential.kind` and the organization;
`credential.effectiveWorkspacePermissions` is the key's workspace grant, and an
empty `workspaceGrants` is expected.

## 2. The product workspace

The embedding proxy (`createSessionProxyRoute`, whose `resolve` returns
`{ user, tenant }` or `{ user }`) creates workspaces and memberships on first
use, so a chat needs no provisioning. Workspace-level setup (an installed API
Integration, schedules, webhooks, budgets) needs the id of the same workspace:
from a server-side script, `await og.workspaceId({ tenant })` (or `{ user }`)
on the `Opengeni` facade from `@opengeni/sdk/chat` returns it, creating it if
needed.

Explicit provisioning is advanced: only when the product manages workspaces
itself, ensure one by external mapping and return `{ user, workspaceId }` from
`resolve`. Write `.opengeni-setup/workspace.json` using the product's stable
identity:

```json
{"externalSource":"acme-product","externalId":"tenant-123","name":"Acme product"}
```

An organization key can omit `accountId`: only its own organization is allowed.
For a human/admin SDK client send the explicit organization UUID as `accountId`.
Use a new external id for a throwaway staging run and save it before the call.

```bash
ogcurl PUT /v1/workspaces/external .opengeni-setup/workspace.json .opengeni-setup/workspace-result.json
export WORKSPACE_ID="$(jq -er '.workspace.id' .opengeni-setup/workspace-result.json)"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID"
ogcurl GET "/v1/config/client?workspaceId=$WORKSPACE_ID" '' .opengeni-setup/config.json
```

SDK: `ensureWorkspace(request)` → `{ workspace, created }`,
`getWorkspace(workspace.id)`, `getClientConfig({ workspaceId: workspace.id })`.
Check `workspace.accountId`, `kind === "shared"`, `externalSource`, `externalId`.
Reusing the exact mapping is safe and does not update existing workspace data.

## 3. Workspace agent defaults and admitted users (optional)

The proxy's `createSession` hook sets the agent per session, so this is needed
only when sessions are also created without an `agent` (for example from the
Opengeni app). PATCH the desired settings. Omission preserves other top-level
settings; nested objects are replacements, so merge desired changes with the
read version.

```json
{"sessionAgentDefaults":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none"}}
```

```bash
ogcurl PATCH "/v1/workspaces/$WORKSPACE_ID/settings" .opengeni-setup/settings.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID"
```

SDK: `updateWorkspaceSettings(workspaceId, settings)`, `getWorkspace(workspaceId)`.
Skip an unchanged desired configuration.

The proxy admits each resolved user on their first request. Only with explicit
provisioning (advanced), admit an authenticated product user: save a UUID
operation id then POST:

```json
{"identity":{"source":"acme-product","externalId":"user-123"},"permissions":["workspace:read","sessions:create","sessions:read","sessions:control","files:upload","files:read","mcp_servers:attach"],"operationId":"00000000-0000-4000-8000-000000000001"}
```

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/external-members" .opengeni-setup/member.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/members"
```

SDK: `addExternalWorkspaceMember(workspaceId, request)` and
`listWorkspaceMembers(workspaceId)`. The raw GET response is
`{ members: WorkspaceMember[] }`; the SDK already unwraps it and returns
`WorkspaceMember[]`. Use `const members = await og.listWorkspaceMembers(workspaceId)`
and `members.length` or iterate `members` directly, not `members.members`.
Other SDK list methods have their own return shapes; inspect the installed types.
Reuse the exact operation id/request on an
uncertain retry. An existing conflicting/revoked grant is not successful
onboarding; do not silently revoke or widen it. Follow the embedding skill's
explicit membership-update contract for an authorized permission change.

## 4. Product tools and approvals

Wire tools after the chat answers. Prefer what the product already has: an
existing MCP server (attached per session, below) or an existing focused
OpenAPI 3.0/3.1 description, installed per workspace. With many tenant
workspaces, prefer the session-level MCP attachment or the embedding proxy's
`toolServer`, which need no per-workspace install. For a private OpenAPI API,
first create a workspace Connection. Its body is:

```json
{"providerDomain":"api.acme.example","kind":"api_key","ownership":"workspace","credential":{"headers":{"Authorization":"Bearer <product-scoped token>"}},"grantedScopes":[],"metadata":{},"operationId":"00000000-0000-4000-8000-000000000002"}
```

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/connections" .opengeni-setup/connection.json .opengeni-setup/connection-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/connections"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/connections/operations/$CONNECTION_OPERATION_ID"
```

SDK: `createConnection(workspaceId, request)` returns metadata (not the token);
`listConnections(workspaceId)` verifies its id/domain/ownership. Persist the
operation id before creation; the operation lookup reconciles an uncertain
response. Use a Connection's stable id, not a secret in the spec URL. A generic
brokered Connection requires header/query/cookie placement, not `{ apiKey }`.

Preview body, omitting `connectionId` for an unauthenticated product API:

```json
{"source":{"kind":"openapi","url":"https://api.acme.example/openapi.json"},"connectionId":"00000000-0000-4000-8000-000000000003","ownership":"workspace"}
```

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/integrations/preview" .opengeni-setup/preview.json .opengeni-setup/preview-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/integrations"
```

SDK: `previewApiIntegration(workspaceId, request)`. This is non-mutating.
Inspect `tools[].id`, `safety`, `approvalMode`, auth placements and warnings.
An inline document alternative is `source: { kind: "openapi_document",
sourceKey: "acme-product-v1", document: JSON.stringify(spec), baseUrl }`.
Resend the identical document on installation.

Build `.opengeni-setup/install.json` from the exact preview (using a structured
JSON editor/jq, not string substitution). `allowedTools` contains **preview
tool ids**, not guessed operation names:

```json
{"source":{"kind":"openapi","url":"https://api.acme.example/openapi.json"},"expectedRevisionId":"<preview.revisionId>","expectedContentSha256":"<preview.contentSha256>","connectionId":"00000000-0000-4000-8000-000000000003","ownership":"workspace","instanceKey":"acme-product","displayName":"Acme product","allowedTools":["<reviewed preview.tools[].id>"],"autoApprovedTools":[]}
```

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/integrations/install" .opengeni-setup/install.json .opengeni-setup/install-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/integrations"
```

SDK: `installApiIntegration(workspaceId, request)`, `listApiIntegrations(workspaceId)`.
For an existing `instanceKey`, reuse the listed `instanceVersion` as
`expectedInstanceVersion` when an authorized update is needed; skip identical
revision/digest/tool policy. A 409 requires reread/repreview, not a fabricated
version. Save `serverId` for `tools: [{ kind: "mcp", id: serverId }]`.
`autoApprovedTools: []` leaves write/destructive operations asking. Only add
explicitly authorized unattended writes; omitted `autoApprovedTools` restores
asking on updates. Session MCP policies do not override this install policy.

### Existing product MCP instead of OpenAPI

Do not build a new MCP server for this plugin. An existing product server can
be attached through the session request (the proxy's `createSession` hook, or
the smoke session in step 7):

```json
{"mcpServers":[{"id":"acme","url":"https://api.acme.example/mcp","allowedTools":["get_report"],"requireApproval":true}],"tools":[{"kind":"mcp","id":"acme","eager":true}]}
```

Add write-only `headers` or the supported
`connectionRef`; never place a secret in the URL. Read the created session's
`effectiveToolPolicy`/`effectiveTools` and then actually call a safe product
tool. `requireApproval: true` asks on every call; `false` removes this local
policy but not catalog floors; an array asks on those exact MCP tool names.
To change an attached server's policy:

```json
{"requireApproval":true}
```

```bash
ogcurl PATCH "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID/mcp-servers/acme/approval-policy" .opengeni-setup/approval.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID"
```

SDK: `updateSessionMcpApprovalPolicy(workspaceId, sessionId, "acme", request)`.
The update takes effect from the next claimed attempt. A tool selection or
approval setting never gives the product API more authority.

## 5. Schedules and event-driven work (only when requested)

Create a schedule paused, with its stable provisioning key in `metadata`.
First list schedules and reuse the one matching that key; if multiple match,
stop and reconcile instead of POSTing another. Inspect all pages where a
listing supports pagination. Save the returned id immediately. There is no
schedule-create idempotency key.

```json
{"name":"Acme morning summary","schedule":{"type":"calendar","hour":8,"minute":0,"timeZone":"Europe/Oslo"},"status":"paused","agentConfig":{"prompt":"Summarize the latest report using Acme's tools.","agent":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none"},"sandboxBackend":"none","tools":[{"kind":"mcp","id":"<installed serverId>"}]},"metadata":{"developerSetupKey":"acme-product:morning-summary"}}
```

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks" .opengeni-setup/schedule.json .opengeni-setup/schedule-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks/$TASK_ID"
```

SDK: `listScheduledTasks`, `createScheduledTask`, `getScheduledTask` (all with
`workspaceId`). Use the requested time zone, not the example time zone.
`agentConfig.agent` carries the product agent.
Scheduled tasks accept installed workspace tools, **not inline `mcpServers`**.
After verification and requested activation: `POST .../:taskId/resume` /
`resumeScheduledTask`. Verify GET status again. For one verification fire,
`POST .../:taskId/trigger` with a saved `{ "triggerId": "setup-check-v1" }` /
`triggerScheduledTask`; verify `GET .../:taskId/runs` / `listScheduledTaskRuns`.
Do not manually trigger an unrequested real business write.

For inbound events, use `@opengeni/sdk/automations`'s
`OpenGeniAutomationsClient`, not outbound workspace webhooks:

```json
{"name":"Acme product events","adapterId":"signed-json.v1","webhookSecret":"<locally generated secret, at least 16 characters>","configuration":{}}
```

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/automations/sources"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/automations/sources" .opengeni-setup/source.json .opengeni-setup/source-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/automations/sources"
```

SDK: `listSources(workspaceId)`, `createSource(workspaceId, body)`. Reconcile
the saved source id/name; creation has no idempotency key. Save the returned
`webhookPath` rather than inventing an ingress URL. Create a paused trigger:

```json
{"sourceId":"00000000-0000-4000-8000-000000000004","name":"Acme report changed","eventTypes":["report.changed"],"status":"paused","configuration":{},"parameters":{},"sessionTemplate":{"prompt":"Summarize the changed report.","agent":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none"},"sandboxBackend":"none","tools":[{"kind":"mcp","id":"<installed serverId>"}]}}
```

Automation templates default omitted `firstPartyMcpTools` and
`firstPartyMcpPermissions` to `[]`, so a product-only automation inherits no
Opengeni tools or permissions without listing them. Startup skips remote
Opengeni-delegated MCP preparation without minting a token or calling its
endpoint. Requested first-party tools or dedicated `files`/`docs` remain
unavailable with an `insufficient_scope` advisory. Do not pad the grant with
`sessions:read`. The installed product server keeps its separately authorized
connection or host credentials; external-host servers and already-authorized
native runtime mechanics are not disabled by this ceiling. See
`docs/automations.md` for the exact boundary.

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/automations/triggers"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/automations/triggers" .opengeni-setup/trigger.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/automations/triggers"
```

SDK: `listTriggers`, `createTrigger`; authorized activation uses
`updateTrigger(workspaceId, triggerId, { expectedRevision, status: "active" })`
and `PATCH .../automations/triggers/:triggerId`, then list/verify again.
Use the read revision. Test the signed product ingress per
`docs/automations.md`, or `triggerManually` / `POST .../sources/:sourceId/events`
with a stable `occurrenceKey` for a safe test, then `listRuns` /
`GET .../automations/runs`. Registration alone is not an ingress test.

## 6. Outbound webhook and per-run credential provider

Read/reconcile by saved id plus URL/description before creating a webhook.
POST is not idempotent; an uncertain response needs inventory, not a blind
retry. The response includes the signing `secret` (returned once):

```json
{"url":"https://api.acme.example/opengeni/events","eventTypes":["turn.completed","session.requiresAction"],"enabled":true,"description":"acme-product developer setup"}
```

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/webhooks"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/webhooks" .opengeni-setup/webhook.json .opengeni-setup/webhook-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/webhooks/$WEBHOOK_ID"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/webhooks/$WEBHOOK_ID/test"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/webhooks/$WEBHOOK_ID/deliveries"
```

SDK: `listWorkspaceWebhooks`, `createWorkspaceWebhook`;
`getWorkspaceWebhook(client, workspaceId, webhookId)` and
`testWorkspaceWebhook(client, workspaceId, webhookId)` from
`@opengeni/sdk/workspace-integrations`; `listWorkspaceWebhookDeliveries`.
Keep the signing secret on the product backend. Verify the exact raw body
with `verifyWebhookEvent`. A 2xx test without receiver signature verification
is insufficient. Deliveries are at-least-once and unordered; deduplicate
their event id, then read the session through the authenticated API.

Configure per-run credentials only when the product needs them:

```json
{"url":"https://api.acme.example/opengeni/credentials","enabled":true,"timeoutMs":10000}
```

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/credential-provider"
ogcurl PUT "/v1/workspaces/$WORKSPACE_ID/credential-provider" .opengeni-setup/provider.json .opengeni-setup/provider-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/credential-provider"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/credential-provider/test"
```

SDK: `getWorkspaceCredentialProvider`, `putWorkspaceCredentialProvider`,
`testWorkspaceCredentialProvider(client, workspaceId)` from
`@opengeni/sdk/workspace-integrations`. PUT is an update, not a rotation:
`secret` exists only at first creation. Preserve the existing secret on rerun.
Verify raw-body signatures with `verifyCredentialProviderRequest`, authorize
the signed scope and exact targets, and return bounded short-lived credentials.
See `docs/workspace-integrations.md` for the callback protocol. Store each
webhook/provider secret in its own server-only variable or secret-manager
entry.

## 7. Budget, smoke session and embedding handoff

Budget configuration is a workspace ceiling against the organization credit
pool, not a credit purchase. Get its lifecycle state even when no configuration
exists; use `state.version` (initially `0`) for the next compare-and-set:

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/allowance/state" '' .opengeni-setup/allowance-state.json
```

Example only: a requested monthly $10 ceiling is `10000000` USD micros:

```json
{"expectedVersion":0,"includedCredits":10000000,"period":"monthly","anchorDay":1,"memberDefault":"none","thresholds":{"workspace":[0.8,1]}}
```

```bash
ogcurl PUT "/v1/workspaces/$WORKSPACE_ID/allowance" .opengeni-setup/allowance.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/allowance"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/usage"
```

SDK from `@opengeni/sdk/usage-allowances`: `getWorkspaceAllowanceState(client,
workspaceId)`, `setWorkspaceAllowance(client, workspaceId, request)`,
`getWorkspaceAllowance(client, workspaceId)`, `getUsage(client, workspaceId)`.
On an unchanged configuration skip PUT. On 409 reread and compare the desired
state; do not increment a guessed version. Concurrent/in-flight calls can
overshoot a ceiling; it is checked before subsequent calls. Never buy credits
or change a financial commitment merely to make a test pass.

An optional API smoke session checks the workspace before (or besides) the
embedded chat. Read config again for this workspace and choose an available
model, or omit `model` to use its server-resolved default. Save the
idempotency key before POST:

```json
{"initialMessage":"Reply SETUP_OK, then use the selected product read tool if available.","idempotencyKey":"acme-product:setup-smoke:v1","agent":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none"},"sandboxBackend":"none"}
```

Once product tools are wired, add only the verified installed server refs as
`tools`, or the existing product MCP attachment above.

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/sessions" .opengeni-setup/session.json .opengeni-setup/session-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID/events"
```

SDK: `createSession`, `getSession`, `listEvents` (workspace id and session id).
Read until the first completed answer or actionable refusal; don't count a
201 alone. With tools configured, verify a safe tool call and its useful
result, and an approval-gated call if intended. Never approve an unrequested
business mutation as a smoke test. The embedded chat itself follows
[opengeni-client](../../build-with-opengeni/opengeni-client/SKILL.md): its server-owned proxy and
`createSession` hook carry the same agent and tools. Setup-key expiry is
intentional; shipping needs a separately scoped runtime credential, created
by the authenticated administrator, without widening this setup key.

## Reruns, failures and cleanup

| Result | Recovery |
| --- | --- |
| 401 | Check target and local key presence/expiry; create a new key if it was revoked or expired. |
| 403 | Read `/v1/access/me` and the exact denied permission; verify the organization and that the key is the full-access setup key. |
| 404 | Recheck deployment feature availability and workspace ownership; don't fall back to a Personal workspace. |
| 409 | Read current version/digest/grant and compare intended change. Repreview schema drift. Don't reuse an operation id with changed inputs. |
| 422 `agent_capability_unavailable` | Read advertised capabilities, remove only an optional unsupported capability, otherwise report the missing feature. |
| 429, 5xx, timeout | Retry reads with bounded backoff. Reconcile writes via mapping/id/operation receipts before any retry; non-idempotent POSTs can have succeeded. |
| `requires_action` | Inspect approval/human-input events. Let the authenticated user resolve a real required decision, not a fabricated response. |
| `allowance_exhausted`, unavailable model/provider | Read usage/config. Use an already authorized usable model; don't buy credits, widen budgets or borrow another user's provider. |
| Callback/private URL refusal | The hosted control plane cannot use localhost/private endpoints. Use the product's existing public HTTPS route or an authorized tunnel. |

Clean up **only disposable staging resources this run created**.
Pause/remove schedules, disable automation triggers/sources, delete webhooks and
provider, uninstall the exact API Integration instance, delete its disposable
Connection, cancel/remove the smoke session, then delete the throwaway workspace.
Never delete reused resources. Automation DELETE calls disable, not delete:
verify the saved ids remain with `status === "disabled"` in
`GET .../automations/triggers` / `listTriggers` and
`GET .../automations/sources` / `listSources`. Disabled records remain listed.
For resources actually deleted, verify inventory absence and, where an exact
GET is supported, 404.

REST → SDK cleanup calls:

- `DELETE .../scheduled-tasks/:taskId` → `deleteScheduledTask`.
- `DELETE .../automations/triggers/:id?expectedRevision=<read revision>` and
  `DELETE .../automations/sources/:id` → `disableTrigger`, `disableSource`.
- `DELETE .../webhooks/:id`, `DELETE .../credential-provider` →
  `deleteWorkspaceWebhook`, `deleteWorkspaceCredentialProvider`.
- `GET .../integrations/:capabilityId/instances/:instanceKey/uninstall-preview`,
  then `DELETE .../integrations/:capabilityId/instances/:instanceKey` with its
  exact requested uninstall contract → `previewApiIntegrationUninstall`,
  `uninstallApiIntegration` (see the typed SDK example).
- `DELETE .../connections/:id` → `deleteConnection`.
- `POST .../sessions/:id/cancel`, `DELETE .../sessions/:id` → `cancelSession`,
  `deleteSession`; wait for cancellation settlement before deletion.
- `DELETE /v1/workspaces/:id` → `deleteWorkspace`; verify the workspace is
  absent from `GET /v1/workspaces` / `listWorkspaces` and its exact GET is 404.
- The authenticated organization administrator revokes the disposable key
  with `DELETE /v1/organizations/:id/api-keys/:keyId` /
  `deleteOrganizationApiKey`, then checks inventory and 401 with the old key.
  The setup key cannot revoke or mint organization keys.

Retain a non-secret pass/fail/cleanup summary. Remove local secret response
files after saving any required secrets in their intended secure store.