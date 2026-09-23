# Embedding authority internals

Companion to [the architecture map](architecture.md), [product integration](product-integration.md) and [remote MCP credentials](remote-mcp-credentials.md). Code and current tests own exact behavior.

Connector discovery resolves account-qualified execution tool IDs through the
current turn's accepted bindings. An enabled connector is not proof of a usable
account. Missing tools with an accepted account, or historical work lacking an
account snapshot, report execution unavailability rather than inventing a need
to reconnect. Actual credential failures retain their native recovery notices.
Custom native OAuth installations supply omitted catalog authentication metadata
from their stored connection kind; host-managed references never become native
OAuth recovery targets.

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
company checks and workspace-only ownership. Personal connection setup uses the
verified canonical actor, including organization-key `asUser` requests. An
unscoped service request is not human ownership. Callers must authenticate and
reauthorize the actor before storage: an RLS scope is not authentication.
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
MCP credentials use the ordinary native connection store, OAuth refresh engine
and accepted native connection authority. The old host registry/delegation HTTP
APIs, SDK methods, callback broker and public selection fields are removed.
Migrations 0443–0448 and 0453 remain historical schema, with legacy persistence
cleanup tracked separately; their tables do not make the deleted APIs available
or authorize native credential use. See [the cutover note](remote-mcp-credentials.md).

`initializeSessionStartAtomically` now offers a backend-only
`captureInitialTurnAuthority` callback for newly inserted initial turns, under
the same activity transaction as initial events. Capture failure rolls back
both; replay never attaches authority to an existing turn, and deferred starts
reject this callback. External identity-link authority still uses this seam;
host credential selection does not.
Core `createAndStartSessionWithOutcome` carries this backend callback through
the shared finish/repair stage with the exact persisted session and turn IDs.
Native session creation, send/steer and composer submission select for the
current named participant. Session-local MCP definitions participate in that
selection. Native task revisions freeze connection selection for all three
scheduled run modes; an existing-session task uses its target's persisted tools
and MCP definitions. Retries retain accepted selection rather than choosing a
different account. Empty realtime creation captures no connection authority;
the first text turn selects under its authenticated participant.
`live-session-attempt.ts` owns the shared active-attempt/interruption/link fence
used by native execution. `scheduled-task-revision-authority.ts` reads the native frozen
revision without importing the DB root barrel. Owner-migrated PostgreSQL tests
exercise both schedules and private SuperGrok connections under FORCE RLS;
the scoped lifecycle routines retain membership locks and restore their markers.
Turn authority ledgers also use the native restrictive session-reference policy;
owning a connection does not bypass private-session visibility. Private
Connect origin triggers have no PUBLIC execution grant, including to artifact
materializer roles.
Optional native links (0449–0452) retain distinct external/native identities.
`asLinkedUser` explicitly selects the live native delegation; immutable linked
task/turn snapshots propagate through all scheduled modes, child sessions and
causal continuations. Runtime execution and credential-use checks deny revoked
links without tying durable work to the original API key. Linking does not
transfer personal connection ownership. Native consent and account inventory reuse the shared
React link surfaces; inventory is participant-scoped and cursor-bounded.
The DB create boundary strips retired selection metadata from new input and no
longer accepts host-selection arguments. `retired-session-create-metadata.ts`
keeps only a historical replay rejection: nonempty or malformed stored host
selection cannot be mistaken for a native create using the same idempotency key.
Historical records are not rewritten. This compatibility check grants no access.
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
The named `gmail` Connect adapter reuses generic MCP OAuth with the reviewed
Gmail endpoint fixed server-side. It permits personal ownership only, including
reconnect, and lists existing exact-endpoint Gmail accounts under the same provider.
Connecting an account does not install or grant a mail capability; normal capability
selection, named-user authority, and tool approval policy still apply.

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

## Inline HTML and chat previews

HTML-only Sites can explicitly include
`<script src="/__opengeni/site-tools/client.js"></script>` before author scripts.
The existing Codemode Site request handler serves the installed SDK's generated
browser runtime at that path. Published frames resolve that optional tag using
the viewer's deployed SDK; ordinary bundled React Sites are unchanged. This
is the same SDK and bridge, not another protocol. SDK builds regenerate the
browser entry with `scripts/generate-site-browser-runtime.ts`. Published HTML
and sandbox previews use their respective host SDK versions, with the existing
bridge/API compatibility checks. No package-image delivery or Bun build change
is required for existing Sites.
Assistant messages opt into `opengeni-html` and `opengeni-site` fences through
the shared Markdown host callback. Only source-complete fences mount previews;
user messages and ordinary HTML fences remain inert Markdown. The web host's
`ChatInteractiveBlock` uses the existing `ArtifactSandbox` and published frame
for both. Saved Site embeds load through `loadSiteSnapshot`, optionally selecting
a saved version and its exact tool declarations. Inline HTML uses the same
bridge without a fabricated Site identity; API calls retain ordinary current
viewer authorization and tool approval. No sandbox download is needed to render
message-owned HTML.
Inline visualizations receive the shared visualization stylesheet and helper scripts,
with frame-scoped resize messages and theme updates; ordinary Sites are unchanged.
The CSS/helpers under packages/react are canonical. generate-visualization-assets.ts
generates both the renderer constants and the visualization skill’s preview/export
assets from them. The default opengeni-visualize skill owns detailed inline design
guidance; the main operational prompt only routes to it and to opengeni-sites.
Markdown image references use artifact:<uuid>. The native chat resolves metadata
through the current workspace API and reuses the retained-artifact image loader
(object URL cleanup, unavailable states, and current viewer authentication).
Neither sandbox paths nor storage credentials are embedded in message image URLs.

## Connection presentation

`@opengeni/react/connect` exports `ConnectionLogo`, `ConnectionInstalled`,
`ConnectionServiceRow`, `ConnectionOptionRow`, `ConnectionCatalog`, and
`ConnectionTypePicker`; scoped styling is in `@opengeni/react/connect.css`.
These components accept data and callbacks, without app routing or provider
credentials. `ConnectPanel` and `ConnectChooser` optionally use the catalogue
presentation over the existing shared connection controller.
The web Capabilities route owns tabs, global search, and curated ordering.
`apps/web/src/components/capabilities/connection-services.ts` groups explicit
provider identities without merging their independent authorization options.
Northstar demonstrates the same SDK catalogue with its existing API proxy.

In catalog mode, `ConnectPanel` presents available provider adapters and MCP
services through one searchable `ConnectionDiscovery` list. The optional custom
connection chooser remains separate. Service presentation is shared by discovery
and account rows; personal credentials do not need a workspace installation
reference to display their service name and logo. Display matching never selects
a credential or changes ownership. Curated API integrations retain the explicit
tool-selection step after OAuth; authorizing an account alone does not install
its operations.
