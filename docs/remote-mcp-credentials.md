# Optional remote host MCP credentials

Short runs may continue to supply inline, short-lived MCP headers. They do not
require a callback service or renewable grant to the host API. Once those
credentials expire, OpenGeni cannot manufacture renewed authority. A future
scheduled run or a long agent that outlives the token needs renewable credentials
or must stop for authentication. Native provider OAuth refresh remains separate.

For a host-owned tool, the optional remote adapter implements the existing
`ConnectionCredentialsPort.mcpCredentials` seam. Configure
`OPENGENI_HOST_MCP_CREDENTIAL_RESOLVERS_JSON` on the API and workers as a JSON
array of `{accountId, url, bearerToken, timeoutMs}`. Each organization may have
one entry; the endpoint must use HTTPS and obey the existing outbound-network
policy. The bearer authenticates OpenGeni to the resolver, not to the tool.
Store this configuration in the deployment's secret manager, never browser
configuration, session data, or a Skill.

## Native instance registration

Independent embedding instances can instead register one resolver per stable
workspace `externalSource`. Use a server-side organization API key with literal
`account:admin`; `asUser`, `asLinkedUser`, workspace keys, delegated tokens, and
browser cookies cannot administer these routes. Registration configures transport,
not a tool permission, binding, grant, membership, or accepted initiator.

```ts
const resolver = await service.putHostMcpResolver(organizationId, "instance:example", {
  operationId: registrationOperationId, // retain and reuse for exact retries
  expectedGeneration: 0, // create; updates require the current generation
  url: "https://backend.example/opengeni/mcp-credentials",
  bearerToken: resolverSecret, // server-side secret, never browser configuration
});
const { workspace } = await service.ensureWorkspace({
  accountId: organizationId,
  externalSource: "instance:example",
  externalId: customerId,
  name: customerName,
});
```

The HTTP contract is `PUT`/`GET
/v1/organizations/:organizationId/mcp-credential-resolvers/:externalSource` and
`POST .../:externalSource/revoke`. Encode the source as a path segment; the SDK
does this automatically. `PUT` requires `operationId`, `expectedGeneration`,
`url`, and `bearerToken`; optional `timeoutMs` retains the remote adapter's
100–30,000 ms range and 10,000 ms default. `GET` and mutation responses contain
metadata only. `revokeHostMcpResolver` requires an operation ID and current
generation. Schemas live in `@opengeni/contracts/host-mcp-resolvers`.

Source matching uses the authoritative workspace row and exact organization;
sources are trimmed, case-sensitive routing labels, not external-user identity
sources or access grants. Register before or after creating workspaces. Every
future `ensureWorkspace` with that source uses the registration automatically.
No per-workspace resolver configuration, per-instance runtime restart, or custom
dispatcher is needed once the native-support release is deployed.

The **first registration opts the whole organization into namespace routing**.
When a static account resolver exists, that first PUT must explicitly set
`acknowledgeLegacyRoutingReplacement: true`, otherwise it returns 409 without
writing. Organizations with no registration rows retain static routing. Once
any row exists, including a revoked row, an absent workspace source, unregistered
source, inactive registration, or database failure denies resolution; there is
no fallback to the static account endpoint or another instance. Existing
workspaces without a matching source must be considered before opting in.
API/worker static configuration must be consistent during legacy migration.
There is no delete or return-to-legacy operation.

PUT also rotates the endpoint/secret or reactivates the same stable registration.
Every update requires the current generation and a complete explicit bearer;
changing a URL never forwards the previous bearer automatically. Updates and
revocation increment generation. Concurrent stale updates return 409. Reusing
an operation ID with the exact normalized request and actor returns its original
metadata receipt, **without restoring its old endpoint, secret, or status**.
Different input under that ID conflicts. Authentication and the exact live admin
key are rechecked on replay. Use GET for current state; receipts are historical.

An administrator is trusted to update transport for the same instance. Existing
still-authorized turns, schedules, and children may resolve at the new endpoint
without regranting; their immutable initiator and accepted binding/grant snapshots
never change. Credentials resolved under a superseded generation are denied at
physical use. Revocation blocks resolution/use; explicit reactivation restores
transport eligibility only, not revoked membership, binding, grant, or attempt
authority. Already-dispatched remote requests cannot be recalled.

The native adapter reuses the same callback envelope, pinned outbound HTTP rules,
redirect refusal, response/timeout bounds, and exact credential scope validation.
HTTPS is required except loopback HTTP in local/test; private-network destinations
remain governed by the existing network policy. Secrets use native AES-GCM
encryption under `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY`, with registration,
organization, source, endpoint and generation verified inside the encrypted
bundle. Idempotency stores a domain-separated keyed digest and metadata receipt,
not plaintext secrets. Provider credentials are not persisted or cached.

### Native registration rollout

Migration `0463_host_mcp_resolver_registration.sql` is maintenance-only because
it changes the exact runtime table/role contract. Stop old API/control/turn
workers, supply the complete application role list, migrate and provision roles,
then start the matching binaries. Do not restart pre-0463 binaries afterward.
In-process hosts that explicitly supply their own credential port retain
precedence; opting into native routing uses `createNativeRemoteMcpCredentialsPort`.

## Accepted tool authority

New host references require the existing fleet admission flag
`OPENGENI_HOST_MCP_AUTHORITY_SOURCE_ADMISSION_ENABLED` and explicit
`connectionRef.authoritySource: "host"`. This remote adapter does not capture
native connections or reinterpret legacy markerless references. In-process host
ports retain their existing behavior when `mcpAuthoritySource` is omitted.

The opt-in `connectionRef.hostBinding: {bindingId, generation}` reference is
stricter: the credential broker requires a backend-owned live binding validator.
Binding ownership follows the effective organization member. In explicit
`asLinkedUser` mode, create a separate native-owned binding: an external user's
old binding does not transfer to the native user. Native membership revision and
the revocable link revision are independent checks. Linked scheduled/child work
retains both its exact selected binding and the link restriction at physical use.
It validates before and after host resolution and returns the existing
`authorizeProviderRequest` callback for transports to recheck immediately before
each physical request. Every check uses the original immutable request snapshot;
revocation or validator failure denies use even after credentials were resolved.
The standalone broker does not add binding validation to references without
`hostBinding`.

Worker host execution has a separate local attempt-liveness check, including
legacy opaque host references. The worker reads the canonical active-attempt
projection and compares the accepted turn ID and execution generation before
resolution, after resolution, and before each physical request. A stopped or
superseded attempt denies use; a database outage fails closed as `refresh_failed`.
This check does not depend on the original organization API key and does not
establish durable delegation, owner membership, or binding authority. Native
connection references retain their accepted-use authorization; inline credentials
do not enter this host broker.

Agent-attempt Codemode calls dispatch into the worker's prepared tool environment,
so they share this worker resolver and attempt-liveness check; the API does not
construct a second turn credential resolver. The shared worker resolver currently
labels its credential context `surface: "model"`, including calls dispatched by
Codemode. Hosts must not use that field to distinguish these two invocation paths.
This differs from the explicit non-turn `workspace_gateway` callback below.

The host binding registry stores immutable metadata and terminal revocation, not
execution permission. The worker installs an accepted-work validator that requires
an immutable captured snapshot and live membership/session/grant/binding checks.
Direct external-user session creation captures these snapshots when explicitly
selected. Scheduled runs and child/goal successors use separate exact capture
paths below. Missing snapshots and request-time gateway durable references are denied.
Do not infer scheduled or nested execution authority from registry ownership,
session creator metadata, or the scheduler's technical identity.

Internal host delegation persistence stores session-bound or reusable grants,
the binding and owner revisions, shared-output acknowledgement, and terminal
revocation. These rows contain no credential or API key. A grant alone is not an
accepted-work snapshot; creating a row does not enable a workflow to execute.

The internal direct-admission builder reads live owner membership, delegation,
binding, session visibility/epoch and queued-turn provenance while holding locks
through its capture callback. Wrong-owner, stale, revoked or already-claimed work
is rejected. It must be called by a verified authority boundary inside canonical
accepted-work persistence; it does not store a snapshot or authenticate an owner
by itself. Direct create/send/steer boundaries authenticate and invoke it; task,
child and causal resumption capture use their own canonical acceptance boundaries.

`captureDirectHostMcpAuthority` now provides the internal persistence callback:
the owner-scoped `host_mcp_turn_authorities` ledger stores one immutable canonical
snapshot per turn/server. The insert guard reconstructs authority independently;
replay cannot replace the selected delegation. Application privileges deny update
and delete, and foreign keys block deletion/recreation of referenced metadata.
Direct initial-turn admission calls this helper atomically with initial events. The worker's
`authorizeDirectHostMcpUse` (historical internal name) consumes captured rows,
rechecking exact attempt/generation, active external owner membership, workspace
access, session visibility/epoch, delegation and binding generation, and complete
credential destination/selection. It runs before and after credential resolution
and before physical use. No original API key is required. No stored row means denial.

Verified external owners use `POST /v1/workspaces/:workspaceId/host-mcp-delegations`
with `{operationId, bindingId, expectedBindingGeneration, grant}`. The grant uses
the native `scope: "user"`, `mode: "session" | "always"`, and visibility context;
shared output requires explicit acknowledgement, and session mode requires the
session ID and expected authority epoch. GET by delegation ID and POST to its
`/revoke` subresource (with `expectedGeneration`) are owner-scoped. Reads require
`connections:read`; mutations require `connections:write`. Unscoped service and
linked-native callers are not admitted. The same live external proof is checked
inside the persistence transaction. SDK methods are `issueHostMcpDelegation`,
`getHostMcpDelegation`, and `revokeHostMcpDelegation` on the actor-bound client.

Select grants in `createSession` using
`selectedHostMcpDelegations: [{serverId, delegationId, generation}]`. This requires
a verified direct external owner with session-create and connection-read access,
an enabled host-authority fleet admission switch, and an explicitly selected MCP
server whose configured URL and binding selection match the registered binding.
The original fixed `connectionRef.hostBinding: {bindingId, generation}` contract
still requires exact identity, generation and definition. For a shared server
whose participants use their own accounts, explicitly configure:

```ts
connectionRef: {
  authoritySource: "host",
  hostBinding: { selection: "accepted_turn" },
  subjectScope: "subject",
  providerDomain: "tools.example",
  provider: "example",
  kind: "delegated",
  scopes: ["read"],
}
```

This configuration-only descriptor forbids `connectionId`. It is a selection
constraint, not a registry grant: each accepted direct turn must select its
authenticated owner's delegation. Registration still takes a concrete binding
definition with `connectionId` and without `hostBinding`. Admission requires the
same server, canonical HTTPS destination and complete provider/kind/domain/
scope/resource/subject-scope definition; only the account identifier may differ.
There is no wildcard, ambient owner lookup or automatic subset widening. The
immutable turn/task snapshot stores the exact selected binding and generation.
The worker resolves the descriptor only through that snapshot and the existing
live authority checks, then passes a concrete fixed reference to the host and
revalidates before physical use. Missing capture denies; another participant's
grant, the creator's account and a stale attempt are never fallback authority.
Session-local MCP configuration follows the same rule on create and follow-up.

This does not rewrite the server configuration or auto-select tools.
The grant's visibility must match the new session. New-session admission
practically uses an `always` grant; session-bound grants target existing sessions.
Direct `sendMessage` and `steerMessage` accept the same explicit selection on
each message, with session-control and connection-read authority. They capture
under the new turn's acceptance transaction; omission grants no host authority
to that turn. The configured server must already be selected in the session.

The selected grants are part of keyed-create identity. Changing or omitting them
on replay conflicts; successful replay does not recapture authority or revive a
revoked grant. A failed capture leaves no initial turn, events, or authority row
(a repairable keyed session shell may remain). Follow-up operation IDs similarly
bind the canonical selection, and failed capture rolls back the prompt receipt,
events and turn. `startMode: "realtime"` creates an empty session with no accepted
turn; initial selection on that create remains unsupported. For an ordinary
text conversation, create the empty shell without selections, then submit the
first text through `sendMessage` with that participant's explicit
`selectedHostMcpDelegations` and `clientEventId`. This captures authority on the
first real text turn just like every later Send/Steer. It does not grant voice
provider delegations authority or inherit a selection from empty-shell creation.
Same-session goal continuations and child-result resumptions use a separate
causal capture path. Migration 0435 proves the consumed machine update names
the exact source turn, matches the unchanged session epoch and visibility, and
copies its immutable snapshot with only the new work/source identifiers changed.
The worker rechecks owner, binding and grant generations at use. Revoked selections
are omitted so the agent can resume to explain lost access without regaining it.
Ordinary new human messages still require explicit selection. Inline credentials
are unchanged, including their finite lifetime: no renewable authority is implied.

### Scheduled and child work

`createScheduledTask` and `updateScheduledTask` accept the same
`selectedHostMcpDelegations` selection. Direct selection requires the verified
external owner. It is frozen on the native task authority revision in
`host_mcp_task_authorities`, without storing an API key or credential. Omission
on update preserves the existing selection; an explicit empty array removes it
from future revisions. Task edits, restore/rollback and first reusable-session
materialization carry the exact selected generations through the native revision
transition. They cannot reassign the owner or change a host account implicitly.

Every accepted scheduled occurrence captures authority into its claimed turn.
New-session-per-run, reusable-session and existing-session modes share the same
validation. Generated sessions require `always` grants with shared-output
acknowledgement. A session grant can target only its exact existing session and
authority epoch. The captured scheduled origin remains attached through later
continuations and children; physical use rechecks native scheduled-run authority
as well as the host owner, binding and delegation. Credential renewal happens
on demand through the configured host resolver, including without a browser or
the original API key.

Children inherit only an `always` grant selected by the exact spawning turn,
and only for MCP servers selected by the child with unchanged visibility.
Session-bound grants never cross into children. An agent-created scheduled task
likewise derives only successor-eligible selections from its current accepted
attempt; it cannot enumerate or borrow the creator's other accounts. The separate
causal-human field is retained even when the initiating actor is the scheduler.
Fixed and accepted-turn server descriptors use the same exact configuration
comparison for agent-created tasks. Scheduled, child and goal execution resolve
only their own inherited snapshots, never reselect an owner's current account.

### Request-time gateway

Verified external-user and organization-service gateway admission can use the
separate opt-in `mcpGatewayCredentials` port for explicit host references. The
remote adapter implements this port. Native and MCP OAuth gateway callers retain
their native resolver; an arbitrary access-grant object cannot enable the host
path. The API rechecks its captured live key/identity/workspace authority before
and after resolution and immediately before each physical provider request.

`McpGatewayCredentialsRequest` uses `surface: "workspace_gateway"`, a request ID,
account/workspace, and an `authority` object containing verified actor kind,
subject ID, and effective permissions. It has no session, turn, attempt or
generation fields. Hosts must authorize this context independently; never invent
turn IDs or reuse another session's authority. The existing `mcpCredentials`
callback receives only turn requests, so in-process hosts must explicitly opt in
to the new callback. Explicit durable `hostBinding` references still fail closed
in this path; this does not implement scheduled or nested execution delegation.

Existing gateway approval filtering still applies. A generic credential-backed
MCP tool requiring human approval is unavailable when its provider lacks a
side-effect-free call preflight. The host credential callback does not supply
that provider preflight or bypass the approval requirement.

## Wire contract

The adapter POSTs JSON `{version: 1, requestId, request}`. `request` is the existing
`McpCredentialsRequest`: immutable account, workspace, session, root, turn,
attempt, generation, initiator, binding, destination, tool, and refresh context.
The host must authenticate the server and authorize the entire context against
its current policy. An opaque connection ID is not authority. In particular,
the host must deny revoked actors, expired delegations, and stale binding
generations; changing a binding's principal/account/scope requires a new generation
or a new immutable binding ID. Never trust the technical caller as a replacement
for the accepted initiator.

Return `{version: 1, requestId, destinationUrl, resolution}`. Copy `requestId`
and the exact requested destination. `resolution` is the existing
`McpCredentialResolution`, including mandatory organization/workspace/session
echoes and matching connection/provider/scopes/resources. For `status: "ok"`,
`expiresAt` is required and must be more than five seconds and no more than
fifteen minutes in the future. Header and HTTP API placements are validated by
the existing connection broker before use. Return `status: "auth_needed"`
when authorization is unavailable; never substitute another account.

For gateway calls, the same envelope carries `McpGatewayCredentialsRequest`.
The resolution must echo `request.requestId` instead of `sessionId`; the outer
envelope still echoes its own `requestId`. A turn-shaped response to a gateway
request (or the reverse) is rejected. All connection, placement, expiry, size,
network and concurrency restrictions remain the same.

The default deadline is ten seconds (configurable from 100 ms to 30 seconds).
Request context and response bytes are limited to 64 KiB. Redirects are not
followed. Exact concurrent requests share one flight, with at most 128 flights
per process. Successful credentials are not cached or persisted. Provider
errors, invalid responses, oversized bodies, and timeouts return authentication
needed without exposing response contents or secrets. No mutation replay policy
is changed by this adapter.

This transport does not itself establish external user identity or native-user
links. The host remains responsible for live policy on host-owned bindings.
End-to-end scheduler restart and real-provider conformance must be verified in
a service-backed environment before claiming those flows validated.