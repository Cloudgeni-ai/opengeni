# Embedding authority internals

Companion to [the architecture map](architecture.md), [product integration](product-integration.md) and [remote MCP credentials](remote-mcp-credentials.md). Code and current tests own exact behavior.

`packages/connect` owns the framework-neutral setup controller and its
transport contract. It keeps durable attempt state distinct from browser
navigation and from credential submission; backend adapters own admission
and persistence, and UI frameworks subscribe to the same controller state.
Its optional browser navigation adapter isolates the popup opener before
provider navigation; backend polling, not popup messages, determines completion.
`packages/react/src/connect-setup.tsx` supplies the optional unstyled setup
form through `@opengeni/react/connect`; `connect-chooser.tsx` supplies the
optional readiness-aware provider/ownership chooser. `connect-accounts.tsx`
supplies version-checked local disconnect confirmation; `ConnectPanel` composes
these surfaces with opt-in scoped `@opengeni/react/connect.css`. Hosts retain navigation and
paginated resource-selection ownership. The native curated-account controller
uses `native-connect-setup.tsx` over the same transport/setup, discovers pending
attempts and retains the exact named installation target/version through OAuth
and operation review. Legacy query callbacks remain readable for in-flight
old setup. Other provider families still require their dedicated adapters.
`packages/react/src/sites.ts` exports the optional `@opengeni/react/sites`
list/detail/lifecycle adapter over the existing SDK artifact client. It reuses
`PublishedHtmlArtifactFrame` and host-provided navigation/tool
bridge callbacks; read-authority refresh failure removes the frame. Native
route adoption and visual acceptance are not implied by this package surface.
Authoring prompts and buttons remain product-owned ordinary session flows:
native `artifact-authoring.ts` retains the console's instructions and model
preference composition. The embedded example owns its own prompts and links;
neither is a dedicated SDK authoring API.
Site display/list methods live on the browser SDK client; authoring and retained
source methods live on the artifact client, inherited by the full public client.
Native and host products share these HTTP implementations. Model device flows share headless polling and optional React
presentation while retaining their separate credential-pool domains.
`packages/sdk/src/site-tool-bridge.ts` owns native/embedded Site catalog filtering,
pinned-version calls and pre-execution stale-catalog recovery. The console's
`site-tool-bridge.ts` is only its HTTP/error adapter, not a second bridge engine.
Canonical Connect wire validation is in `packages/contracts/src/connect.ts`;
`packages/db/src/connect-attempts.ts` owns scoped attempt creation, operation
claims, atomic completion receipts, expiry, and bounded metadata retention.
Migration 0454 freezes the credential-free external continuation privately on
the attempt. Claim and commit recheck both current actor authority and saved
origin, including on replay. The exact return destination and named installation
targets cannot change during setup.
Social connection versions fence reconnect against refresh, disconnect and
upstream-account substitution. Signed callbacks no older than 24 hours can recover navigation
to the saved host return URL but cannot recover credential-exchange authority.
Core `application/connect-authority.ts` shares
native, service-key and external callback checks; `prepareFikenTokenInstall`
shares verified Fiken token persistence between native routes and Connect.
First-party Atlassian and Google Drive knowledge/publication callbacks retain
their account/resource proofs while committing credentials and completion in
one transaction. The native entry points use `NativeConnectSetup`; source-sync
destination controls remain explicit. Public OpenAPI/GraphQL source setup stores
an immutable source after preview, then re-resolves revision/hash and explicit
selected operations through the existing installation validator. No-auth API
sources do not invent credentials. Custom-header MCP setup uses the runtime's
header validator and encrypted storage, distinct from installing server tools.
Fiken OAuth also uses durable claims and atomic completion, retaining its
company checks and workspace-only ownership. Core `application/host-mcp-owner.ts`
admits explicit native or external human selections using the effective owner's
own membership revision; service keys cannot manufacture human ownership.
Callers must still authenticate and reauthorize the actor before this storage
seam: an RLS scope is not proof of authentication.
The internal `packages/core/src/application/connect-operation.ts` coordinator
claims before provider effects and reauthorizes inside completion transactions,
including receipt replays. Provider adapters must supply live authority fences;
failed or uncertain effects leave the claim occupied rather than retrying.
`packages/db/src/external-identities.ts` is the internal external-identity
provisioning seam. It creates a stable organization-scoped opaque mapping and
membership/Personal-workspace anchors, but no native login or shared-workspace
grant. Reuse cannot reactivate suspended or revoked membership.
External-mode admission is resolved separately in `packages/core/src/access/`:
only organization-key authentication can assert an external actor, and its
workspace permissions intersect the live key ceiling with explicit membership.
`OpenGeniClient.asUser` returns an isolated server-side client; it never changes
a shared client's actor or grants membership. Explicit host onboarding lives in
`packages/core/src/application/external-workspace-members.ts` and reauthorizes
under the organization membership fence. External lifecycle administration
reuses native settlement commands; core private/Personal admission uses a
dedicated verified-owning-user proof. Explicit linked-native admission uses the
separate link proof; no external request is stamped as a managed-cookie login.
Workspace gateway admission distinguishes verified external-user and
organization-service-key provenance from native-human and attempt claims.
These new request-time lanes recheck live authority before provider invocation
and approval issuance; existing catalog filtering and approval rules remain
authoritative. This does not supply durable scheduled/binding delegation.
Migration 0443 adds the credential-free `host_mcp_bindings` registry with
FORCE-RLS external-owner scope, immutable destination/identity, idempotent
registration, and terminal generation-advancing revocation. Its DB seam is
`packages/db/src/host-mcp-bindings.ts`; the API adapter is
`apps/api/src/routes/host-mcp-bindings.ts`. Registration/read/revoke use verified
external authority, but registration is not an execution delegation. Do not infer authority
from a registry row, historical creator, or a host credential response.
Migration 0444 adds owner-scoped `host_mcp_delegations` alongside that registry.
Its internal DB API reuses session/always grant scopes, shared-output
acknowledgement, binding generation and live owner/workspace checks. Neither
these metadata rows nor `HostMcpAcceptedAuthority` schemas admit execution:
verified owner HTTP issuance now uses `/host-mcp-delegations`, with the same
commit-time external authority recheck as binding registration. Direct initial-turn
admission captures selected grants; the worker consumes captured direct-turn
snapshots through `authorizeDirectHostMcpUse` and fails closed without one.
`withDirectHostMcpAdmission` in the DB module constructs a direct-turn snapshot
under live owner/grant/session/turn locks and passes it to a capture callback.
It is not authentication or storage; production acceptance must invoke it within
its canonical session-activity transaction and persist an immutable snapshot.
Scheduled/inherited work is deliberately excluded from this direct-only seam.
Migration 0445 adds `host_mcp_turn_authorities`, an owner-scoped FORCE-RLS
direct-turn ledger. `captureDirectHostMcpAuthority` persists the builder's
snapshot; its insert trigger independently reconstructs and checks canonical
authority. The runtime role has only SELECT/INSERT, and foreign keys retain
referenced bindings/delegations until accepted work is removed. Exact replay
cannot replace a turn/server selection. Verified create admission writes this
storage atomically with initial events. Worker live consumption validates
direct or exact same-session causal snapshots, membership/session epochs,
grants and destinations. Scheduled and child work use separate guarded capture
paths rather than relaxing the direct-turn guard.
`initializeSessionStartAtomically` now offers a backend-only
`captureInitialTurnAuthority` callback for newly inserted initial turns, under
the same activity transaction as initial events. Capture failure rolls back
both; replay never attaches authority to an existing turn, and deferred starts
reject this callback. Explicit public host selection uses this callback.
Core `createAndStartSessionWithOutcome` carries this backend callback through
the shared finish/repair stage with the exact persisted session and turn IDs.
The callback is backend-only. `createSessionForRequestWithOutcome` validates
public `selectedHostMcpDelegations` for a verified direct external owner with
connection-read authority, then matches selected tools and exact configured
host URL/ref under the fleet admission switch. The capture callback rechecks
external authority inside the canonical transaction. Service, realtime and
child explicit selections are rejected. Direct follow-up send/steer uses the
same selected-config admission helper, capturing atomically after fresh turn
insertion in `submitHumanPromptInTransaction`. Prompt replay identity includes
nonempty canonical selections; replay never invokes capture.
`host-mcp-task-authority.ts` freezes explicit selections against native task
revisions (0447), carries them through reusable-session promotion and rollback,
and captures scheduled turns before attempt registration. All three native
execution modes retain their existing scheduling rules. Agent-created tasks
inherit only selected live grants from the exact signed calling attempt.
`live-session-attempt.ts` owns the shared active-attempt/interruption/link fence
used by native execution and host credential reads; host reads do not mutate
goal snapshots. `scheduled-task-revision-authority.ts` reads the native frozen
revision without importing the DB root barrel. Owner-migrated PostgreSQL tests
exercise both schedules and private SuperGrok connections under FORCE RLS;
the scoped lifecycle routines retain membership locks and restore their markers.
Turn authority ledgers also use the native restrictive session-reference policy;
owning a host credential does not bypass private-session visibility. Private
Connect origin triggers have no PUBLIC execution grant, including to artifact
materializer roles.
Child initialization (0448) copies only selected `always` grants from the exact
stored spawning turn; session-bound grants cannot cross that boundary.
Scheduled origin survives descendants and is revalidated at physical use.
Optional native links (0449–0452) retain distinct external/native identities.
`asLinkedUser` explicitly selects the live native delegation; immutable linked
task/turn snapshots propagate through all scheduled modes, child sessions and
causal continuations. Runtime execution and credential-use checks deny revoked
links without tying durable work to the original API key. Native host binding
ownership (0453) resolves the effective member's own revision, not the external
authenticating member revision. Native-owned bindings do not expose or migrate
external-owned bindings. Native consent and account inventory reuse the shared
React link surfaces; inventory is participant-scoped and cursor-bounded.
Same-session goal/child-result resumptions separately copy the exact causal
turn's snapshot after canonical delivery and before attempt registration.
`inheritCausalHostMcpTurnAuthorities` and the 0446 insert guard prove the
consumed source, unchanged visibility/epoch and live delegation. Revoked
selections are omitted; no creator/latest-turn fallback is permitted.
The DB create/replay boundary now compares `selectedHostMcpDelegations` through
reserved immutable metadata, normalized by `host-selection-identity.ts` using
contracts validation. Caller metadata cannot override it; missing selection is
empty, and changed/removal replays conflict. This is replay identity only;
it never substitutes for live admission or worker authority validation.
Core `createAndStartSessionWithOutcome` now forwards internal host selections
into both keyed and unkeyed DB creation. Its keyed replay rejects omission,
changed generation or changed delegation ID without invoking capture again.
Early initialized replay compares the same selection without recapturing it.
Curated API Integration OAuth carries encrypted external continuation data in
signed state. `packages/core/src/application/external-continuation.ts` checks
the live identity, explicit membership and organization-key ceiling; the
credential writer rechecks under lifecycle/key locks in its transaction.
Generic MCP OAuth also carries this encrypted continuation and rechecks before
exchange and persistence. Each provider adapter must retain its corresponding
continuation and ownership fences; a generic callback does not establish them.
`apps/api/src/routes/connect.ts` begins and reads durable curated and generic MCP OAuth
attempts. Signed callbacks bind their exact attempt; credential persistence
and attempt receipts commit together, and callback replay does not repeat the
provider exchange. Hosts poll the retained attempt ID after an exact stored
return URL redirect, without added query parameters. OAuth completion records
`connected_but_incomplete` for curated integrations, not integration readiness.
Generic MCP attempts collect a server URL and complete only the connection
requirement; no integration or blanket tool grant is implied. Curated advance reuses
native preview resolution and shared install validation from
`apps/api/src/routes/api-integrations.ts`; installation and the completion
receipt commit together. Tool selection uses stable IDs, and changed source
returns a fresh preview for explicit review. Cancellation stops setup without
revoking committed credentials. The catalog projects provider readiness and
unsupported operations instead of promising universal provider equivalence.
The manual `mcp-bearer` adapter uses the same durable attempt coordinator with
keyed secret-input digests and atomic encrypted credential/receipt persistence.
It binds the MCP URL and version-checks credential replacement. Connection-only
completion does not imply provider verification. Ordinary external direct
credential creation also rechecks its saved external authority inside the
credential transaction; native provider and ownership guards remain in force.
Initial external session creation retains server-derived identity/key/revision
attribution through `packages/core/src/domain/external-creation-attribution.ts`.
The reserved metadata field cannot be supplied by session-create callers or
minted from external-looking grant metadata. It is historical audit data, not
authority for follow-ups, scheduled work, or child sessions. Native fork
creation starts with empty metadata rather than copying this attribution.
Its wire/helper identity reference preserves case and Unicode without
normalization; limits are UTF-8 bytes (1,024 for IDs, 200 for namespaces), and
text that cannot round-trip through PostgreSQL is rejected before querying.
