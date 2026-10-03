# Developer setup: exact REST and SDK calls

Execute in this order. The coding agent uses ordinary HTTPS and its own
computer; it does not call an OpenGeni MCP server. Requests below are checked
against `apps/api/src/routes` and `packages/contracts` in this release.
[setup-sdk.ts](setup-sdk.ts) provides corresponding SDK calls and verification.

## Local secret handling and curl helper

Use the product's editor/secret API to write these **server-only** variables in
its ignored `.env`, preserving unrelated values:

```dotenv
OPENGENI_API_BASE_URL=https://staging.app.opengeni.ai
OPENGENI_ORGANIZATION_ID=<verified organization UUID>
OPENGENI_API_KEY=<once-shown Developer setup token>
```

Load `.env` with the product's existing environment loader. Do not print it or
source a downloaded/untrusted shell file. Protect `.env` and response files
with mode `0600`, and ignore `.opengeni-setup/`. Do not put tokens in URLs,
prompts, screenshots, shell tracing or browser-visible variables. Request and
response files below are local private setup data, not deliverables.

```bash
set -o pipefail
set +x
umask 077
mkdir -p .opengeni-setup
ogcurl() {
  local method="$1" path="$2" body="${3:-}" output="${4:-}"
  local args=(--silent --show-error --fail-with-body --config -
    --request "$method" "${OPENGENI_API_BASE_URL:?}${path}")
  if [ -n "$body" ]; then
    args+=(--header 'Content-Type: application/json' --data-binary "@$body")
  fi
  if [ -n "$output" ]; then args+=(--output "$output"); fi
  printf 'header = "Authorization: Bearer %s"\n' "${OPENGENI_API_KEY:?}" |
    curl "${args[@]}"
}
```

For public bootstrap before a key exists:

```bash
curl --fail --silent --show-error "$OPENGENI_API_BASE_URL/v1/config/client"
```

SDK: `new OpenGeniClient({ baseUrl, apiKey })`, `getClientConfig()`,
`getAccessContext()`. Never use the SDK's implicit production fallback.

## 1. Browser organization bootstrap and scoped key

Authenticate at the explicit target app, let the human finish sign-in,
verification and MFA, then complete its organization-name onboarding or reuse
the intended organization. Organization settings → Developer holds organization
keys; workspace settings → API keys creates the wrong scope for provisioning.
Select **Developer setup** and retain its short expiry. Read the current app's
labels rather than assuming old screen coordinates. Capture its one-time token
directly to `.env`, not through chat or a screenshot.

The authenticated organization administrator's browser API equivalent is
`POST /v1/organizations/:organizationId/api-keys`. Its body is:

```json
{"name":"Product developer setup","access":"developer_setup"}
```

SDK in that authenticated browser/admin context:
`createOrganizationApiKey(organizationId, { name, access: "developer_setup" })`.
The setup key itself must **not** mint keys. Do not send a `permissions` array
to this organization-key route. The preset chooses the exact permission set.
Omit `expiresAt` to keep the short default; the API honors an explicit expiry
override, so 24 hours is a default rather than a hard maximum. Save the one-time `token`
without logging the response. A lost creation response needs inventory and
administrator revocation/replacement, not a blind repeated POST.

The stored scopes are exactly `workspace:create`, `workspace:admin` and
`usage_allowances:manage`, with a 24-hour default expiry. The setup tier does
not permit key inventory, minting, revocation or credential-management
delegation despite its workspace-admin scope. Budget writes additionally
require the canonical same-organization key; do not perform them with an
`asUser` client or a session/agent-attempt credential.

Verify the stored key, showing only safe fields:

```bash
ogcurl GET /v1/access/me '' .opengeni-setup/access.json
jq '{credential,accountGrants,workspaceGrants}' .opengeni-setup/access.json
```

Check `credential.kind`/scope and organization in the actual response;
`credential.effectiveWorkspacePermissions` is the effective organization-key
workspace grant. Empty `workspaceGrants` is expected. Do not expose the raw
key-creation response; access metadata contains no token.

## 2. Ensure the product workspace

Write `.opengeni-setup/workspace.json` using the product's stable identity:

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

## 3. Persona, capabilities and admitted product users

Only if the workspace client config has `agentConfig.enabled === true`, PATCH
the desired settings. Omission preserves other top-level settings; nested
objects are replacements, so merge desired changes with the read version.

```json
{"sessionAgentDefaults":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none","renderer":"opengeni"}}
```

```bash
ogcurl PATCH "/v1/workspaces/$WORKSPACE_ID/settings" .opengeni-setup/settings.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID"
```

SDK: `updateWorkspaceSettings(workspaceId, settings)`, `getWorkspace(workspaceId)`.
Skip an unchanged desired configuration. Do not PATCH these fields when the
admission switch is off. Legacy sessions instead use explicit minimal
`firstPartyMcpTools: []` plus session `instructions`, not a pretend `agent`.

For an authenticated product user, save a UUID operation id then POST:

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

## 4. Product OpenAPI tools and approvals

Prefer an existing focused OpenAPI 3.0/3.1 description. For a private API, first
create a workspace Connection. Its body (secret file, do not print) is:

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
be attached through the session request in step 7:

```json
{"mcpServers":[{"id":"acme","url":"https://api.acme.example/mcp","allowedTools":["get_report"],"requireApproval":true}],"tools":[{"kind":"mcp","id":"acme","eager":true}]}
```

Add write-only `headers` from a private request file or the supported
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
{"name":"Acme morning summary","schedule":{"type":"calendar","hour":8,"minute":0,"timeZone":"Europe/Oslo"},"status":"paused","agentConfig":{"prompt":"Summarize the latest report using Acme's tools.","agent":{"capabilities":"none"},"sandboxBackend":"none","tools":[{"kind":"mcp","id":"<installed serverId>"}]},"metadata":{"developerSetupKey":"acme-product:morning-summary"}}
```

```bash
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks"
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks" .opengeni-setup/schedule.json .opengeni-setup/schedule-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/scheduled-tasks/$TASK_ID"
```

SDK: `listScheduledTasks`, `createScheduledTask`, `getScheduledTask` (all with
`workspaceId`). Use the requested time zone, not the example time zone.
The sample requires agent configuration admission; on a deployment without it,
report minimal scheduled-agent configuration unavailable rather than silently
inheriting broader defaults. `agentConfig.agent` carries the product agent.
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
{"sourceId":"00000000-0000-4000-8000-000000000004","name":"Acme report changed","eventTypes":["report.changed"],"status":"paused","configuration":{},"parameters":{},"sessionTemplate":{"prompt":"Summarize the changed report.","instructions":null,"resources":[],"skills":[],"tools":[{"kind":"mcp","id":"<installed serverId>"}],"firstPartyMcpTools":[],"firstPartyMcpPermissions":[],"model":null,"reasoningEffort":null,"sandboxBackend":"none","policyRole":null,"metadata":{}}}
```

Keep `firstPartyMcpTools: []` and `firstPartyMcpPermissions: []` for this
product-only automation. Automation templates also default omitted arrays to
`[]`; neither form inherits OpenGeni permissions. Startup skips remote
OpenGeni-delegated MCP preparation without minting a token or calling its
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
retry. Capture the response to a protected file because it includes `secret`:

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
entry; never log the SDK response or use a screenshot to inspect the token.

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

Create an actual session. Read config again for this workspace and choose an
available model, or omit `model` to use its server-resolved default. Save the
idempotency key before POST. With agent configuration admitted:

```json
{"initialMessage":"Reply SETUP_OK, then use the selected product read tool if available.","idempotencyKey":"acme-product:setup-smoke:v1","sandboxBackend":"none","tools":[],"bundledSkillIds":[],"agent":{"identity":"You are Acme's product assistant. Be brief and factual.","capabilities":"none","renderer":"opengeni"}}
```

Without admission, omit `agent`, send `instructions` with the persona and
`firstPartyMcpTools: []`. For tools, replace `tools: []` with only the verified
installed server refs, or add the existing product MCP attachment above.

```bash
ogcurl POST "/v1/workspaces/$WORKSPACE_ID/sessions" .opengeni-setup/session.json .opengeni-setup/session-result.json
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID"
ogcurl GET "/v1/workspaces/$WORKSPACE_ID/sessions/$SESSION_ID/events"
```

SDK: `createSession`, `getSession`, `listEvents` (workspace id and session id).
Read until the first completed answer or actionable refusal; don't count a
201 alone. With tools configured, verify a safe tool call and its useful
result, and an approval-gated call if intended. Never approve an unrequested
business mutation as a smoke test. Read
[opengeni-client](../../opengeni-client/SKILL.md) and implement its server-owned
proxy/session integration using these verified ids. Setup-key expiry is
intentional; shipping needs a separately scoped runtime credential, created
by the authenticated administrator, without widening this setup key.

## Reruns, failures and cleanup

| Result | Recovery |
| --- | --- |
| 401 | Check target and local key presence/expiry; authenticate to replace a revoked/expired key. Never echo it. |
| 403 | Read `/v1/access/me` and the exact denied permission; verify organization/scope/preset. Do not switch to Full access. |
| 404 | Recheck deployment feature availability and workspace ownership; never fall back to Personal or production. |
| 409 | Read current version/digest/grant and compare intended change. Repreview schema drift. Don't reuse an operation id with changed inputs. |
| 422 `agent_config_not_enabled` | Send no `agent`/`sessionAgentDefaults`; use the explicit legacy path and report agent defaults unconfigured. |
| 422 `agent_capability_unavailable` | Read advertised capabilities, remove only an optional unsupported capability, otherwise report the missing feature. |
| 429, 5xx, timeout | Retry reads with bounded backoff. Reconcile writes via mapping/id/operation receipts before any retry; non-idempotent POSTs can have succeeded. |
| `requires_action` | Inspect approval/human-input events. Let the authenticated user resolve a real required decision, not a fabricated response. |
| `allowance_exhausted`, unavailable model/provider | Read usage/config. Use an already authorized usable model; don't buy credits, widen budgets or borrow another user's provider. |
| Callback/private URL refusal | The hosted control plane cannot use localhost/private endpoints. Use the product's existing public HTTPS route or an authorized tunnel. |

Cleanup **only disposable staging resources this ledger says this run created**.
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