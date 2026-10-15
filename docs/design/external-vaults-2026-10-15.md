# External vaults: first-wave implementation design

Status: implementation design, recorded before product code.
Baseline: `1c1aa30a5b164cf532c558489bd91ec1a8cbfe41`.
Authorized October 15, 2026; no merge, deployment or paid-provider commitment.

## 1. Outcome and scope

Add a remotely callable external-vault interface for embedding products,
Proton Pass, Keeper Secrets Manager and a customer-controlled Bitwarden
Password Manager bridge. Reuse native vault reach, secret references, item
editing, search and pagination. Preserve the current vault design,
especially Only-me availability, stable references and connection management.
The existing 1Password integration remains supported unchanged at its public
entry points. Other password managers are out of scope.

## 2. Current architecture, verified from source

`packages/vaults/src/provider.ts` defines the in-process `VaultProvider`.
`connectionCredentials.vaultProvider` supplies one host object, which may
contain multiple vaults. The registry currently recognizes `onepassword`,
`host` and the test-only `fake`; `listVaults`/`listItems` return whole arrays.
Provider calls have a connection ID and budget, but no explicit actor tuple.

`provider-sync.ts` atomically replaces the metadata mirror. It currently slices
inventories to 2,000 items, which must not silently certify a partial listing
as complete. Automatic refresh is usage-driven: ten-minute search/open and
two-minute reference-miss thresholds, with eight/three-second foreground waits.
`SecretSearchOutput` does not expose refresh failures. A failed refresh can
therefore produce an apparently authoritative empty search and missing-secret
ask card. These are first-wave shared-layer fixes, not vendor-specific hacks.

## 3. Separate stored secrets from renewable run credentials

The signed organization/workspace credential callback remains separate. Its
session/attempt authority, provisioning, proactive renewal, reconnect, Git/MCP
bindings and cleanup are not replaceable by CRUD on stored items. Sharing
signature/network helpers is appropriate; routing it through editable vault
items is not. This change does not remove that callback or alter its renewal.

## 4. Layering and native reuse

- Contracts own wire schemas and additive source/capability/freshness shapes.
- `@opengeni/vaults` owns the provider port, bounded page traversal and generic
  remote protocol adapter; its transport is injected, not an unrestricted
  fetch hidden behind the adapter.
- Core owns connection classification, authorized credential loading,
  per-request registry selection, refresh and write policy.
- API and worker supply lazy vendor factories and pinned HTTP transport.
- Existing encrypted connection storage owns provider credentials. Do not
  create another secret store or attach provider tokens to sandbox env.
- SDK provides a server-only remote-provider helper and signing verification;
  React/web consume native contracts and existing shared UI primitives.

The Bitwarden bridge uses the same remote protocol. Existing Connected Machine
execution is not a purpose-specific vault service: do not turn a password
lookup into arbitrary host command execution from the API or reuse a task's
Codemode authority for background provider reads. A customer may run the
bridge on a machine they control, including an already-connected machine,
without changing that machine's enrollment protocol.

## 5. Compatibility

Extend, do not replace, the existing in-process provider port and 1Password
routes. Add `protonpass`, `keeper`, `bitwarden` and `external` source identities;
keep `host` for existing injected providers. New paging methods are additive
to the published interface. Old host providers retain their existing array
methods, with explicit bounds at the consuming boundary.

Keep public SDK methods and response fields. New SDK administration helpers
use an opt-in subpath to avoid adding server/vendor dependencies to browser
bundles. Update contract parity and public API snapshots deliberately.

## 6. Connection identity and ownership

Each connection has a stable provider kind, remote account identity when the
vendor supplies one, ownership (`user`, `workspace`, `organization`), label,
verification time and version. The encrypted bundle contains only the
credential/configuration needed by that adapter. Public metadata never
contains tokens, session keys, Keeper bound configuration or response values.

Linking must check provider identity, active connection status and ownership
in the database as well as HTTP. A personal connection backs only its owner's
Only-me vaults. An organization connection cannot silently become a workspace
connection. Cross-workspace reads reuse the existing native provider-connection
home lookup and live vault reach; IDs and display labels are not authority.
Reconnect must retain stable links and reject an unexpected account switch.
Disconnect unlinks locally and revokes stored access; it never deletes a
vendor vault or item.

Setup reserves a credential-empty, `needs_reauth` connection before contacting
the provider. This supplies a stable native connection identity to a remote
host. Bound Keeper configuration is encrypted and version-CAS persisted as
soon as binding succeeds, before a later validation/listing can fail. Pending
connections cannot resolve secrets or be linked. The connection list exposes
`verificationStatus: pending`; a separate authorized Verify action resumes
using the saved configuration, never the consumed one-time token. If no usable
credential was produced, revoke the reservation. Return saved-but-pending
explicitly rather than telling the person to repeat a destructive bootstrap.

Verifying unchanged working credentials does not stage them again or advance
their generation. A transient verification error leaves their ready state
intact; a rejected reconnect clears its candidate and restores the working
state. Real credential and capability changes still fence in-flight adapters,
which report a conflict rather than incorrectly demanding reauthentication.

## 7. Remote protocol and authority

Use a versioned JSON POST envelope, signed with the existing exact-body HMAC
scheme. The request carries request ID, operation, connection identity and
trusted account/workspace/acting-subject context; include session/turn/attempt
or Site context where that native caller has it. No caller may substitute
those facts with body-supplied tenant or user IDs. A MAC authenticates the
request, not the host's authorization decision: the receiver maps native
workspace and subject IDs to its own tenant/user and rechecks access.

One connection's metadata inventory is a fixed declared sharing scope. The
receiver must not return different users' inventories into the same shared
mirror. User-specific stores use separate user-owned connections. Host
authorization may narrow native authorization, never widen it.

Operations: validate/describe, list vault page, list item page, read fields,
create/update item, archive item, and deliberate refresh. Capabilities are
explicit, not inferred from a successful read. The envelope and responses are
bounded and validated. Unknown response fields are rejected or projected
away before storage; provider messages never pass through as secret-bearing
diagnostics. Returned field IDs must be requested IDs.

Registration uses the existing connection/secret-write permissions and owner
checks, including authorized agent attempts for shared connections. Personal
setup requires the verified owner; organization setup requires its admin.
Reuse the integration endpoint policy: HTTPS outside local/test,
DNS-pinned egress, no redirects, private/special addresses refused unless the
operator explicitly permits them, bounded deadline and response bytes.
Keep callback credentials distinct from ordinary MCP header injection.

## 8. Pagination and snapshot safety

New adapters expose cursor pages with bounded page size, next cursor and
snapshot/version identity where available. Cursors are opaque and scoped to
connection, vault, operation and relevant filters; they grant no access.
Every page revalidates authorization. Reject repeated cursors, duplicate
external IDs, malformed pages and excessive page/item counts.

Only a complete successful traversal may replace the mirror or remove absent
items. Interrupted, expired or over-limit traversals retain the old mirror
and report incomplete/unavailable state. A traversal proves absence only when
it is one page or every page carries the same snapshot. Offset cursors
without a snapshot can skip an existing item when an earlier one is deleted
between pages, so such a multi-page listing serves discovery but never
replaces the mirror; the vault reports `provider_inventory_incomplete`, keeps
its previous mirror, and is not reported removed when absent from such a
vault listing. Items beyond the mirror limits (50 fields, 20 websites, 2,048
characters per website) make the inventory incomplete as well; they are never
cut down to fit. The native 2,000-item vault limit remains explicit; never
describe the first 2,000 items of a larger provider vault as its complete
contents. Agent discovery retains its 1,000-row scan budget and next-cursor
behavior.

## 9. Freshness and deliberate refresh

Distinguish the time Opengeni checked the provider from the time the provider
or bridge last synchronized upstream. Metadata listing is not value resolution.
Expose cached/stale/refreshing/unavailable state and last successful check,
safe error code and rate-limit retry time in agent search and human UI.
An unavailable source must not be represented as an empty healthy vault.

Add deliberate refresh to agent discovery and the existing UI action. It
refreshes metadata and bypasses provider item-value caches for subsequent
reads, but never bypasses authority or active provider rate limits. A durable
mirror freshness epoch must invalidate per-attempt value caches across API
and worker processes, not only in the process that handled Refresh. Do not
replay a previously dispatched command after refreshing credentials.

When a reference misses and relevant sources cannot be checked, report the
source failure rather than manufacture a missing-secret ask card. Explicitly
named healthy/hosted vaults should not be blocked by unrelated outages.

## 10. Capabilities and write semantics

Separate create item, update item, archive item, permanent deletion, create
vault, TOTP read/write and file read/write. Keep the old `write` flag for
compatibility, but new UI and validation use granular effective capabilities
intersected with linked mode and provider permissions. Do not call permanent
vendor deletion from the existing recoverable Archive action.

Preserve unknown provider fields during updates. Use expected versions where
supported and report conflicts rather than blind overwrites. No automatic
retry of a provider mutation after an ambiguous timeout. A successful remote
write followed by failed mirror refresh is reported as saved-but-not-yet-
listed, not as a safe invitation to create it again. Request IDs and explicit
idempotency support allow hosts to reconcile retries without exposing values.

## 11. Proton Pass adapter

Official-source review: pass-cli v2.4.2 (October 1), proton-pass-common 2.1.1,
the command docs and Proton's access-token support page. Use the official CLI
and scoped PATs, never a stored full account password. PAT sessions last two
hours; renewal replaces the token. Use `PROTON_PASS_PERSONAL_ACCESS_TOKEN` at
login, a private per-connection session directory, the `env` key provider,
bounded subprocess output/deadline and no shell. Disable telemetry and update
checks. The adapter never shares a session directory with agent processes.

Create uses JSON on stdin. **Do not enable update in wave one:** v2.4.2 accepts
update values only on argv, cannot edit TOTP/timestamp fields or remove fields,
and silently creates a text field for an unknown name. Do not claim a generic
read-write mode means every mutation is supported. Enable recoverable trash
using the actual `item trash` command, not permanent `item delete`. TOTP is
readable and creatable, not updatable. No create-vault capability for scoped
PATs. File support starts read-only only after its bounded temp-file path is
covered; never claim file writes.

List uses `share_id` as vault identity; item list omits field names, so full
metadata requires per-item view. Budget and bound that traversal, surface an
incomplete refresh rather than fabricate field metadata or erase old rows.
Upstream process-local item cache is not a durable value mirror. Prefer an
operator-installed, version-checked binary with a documented verified install
over silently bundling a new GPL binary into release images.

## 12. Keeper adapter

Use the official Secrets Manager SDK. A one-time bootstrap token is redeemed
once and replaced by encrypted bound configuration; reinstalling/retrying must
not assume the consumed bootstrap token still works. Persist SDK state before
claiming readiness. Respect per-folder/record write access, revisions and
per-record mutation status. Never enable a plaintext fallback cache.
Official SDK 17.6.0 source has a module-global cryptographic key cache keyed
partly by fixed names. Use an isolated worker/child module instance for each
connection, serialize its operations, and close it after an idle TTL; a shared
SDK singleton across tenants is forbidden. Capture SDK console output inside
that boundary rather than forward raw errors. Key rotation can update stored
configuration later: persist it by connection-version CAS before readiness is
reported. Do not use localConfigStorage or createCachingFunction.

Shared folders map to vaults. The SDK does not reliably expose a folder's
write grant; represent that as unknown, not verified write access. Writes
still enforce linked mode and upstream permissions. Initially create login
and note records (API keys can be a documented concealed custom field in a
note, not an invented Keeper record type). No archive or permanent-delete
product action: deleteSecret's recovery semantics are not documented. No
top-level create-vault. TOTP updates use oneTimeCode with an otpauth URI.
Warn during setup about the default client-device IP lock; do not clear a
customer's security settings automatically.

## 13. Bitwarden bridge

Integrate Password Manager, not the separate Bitwarden Secrets Manager
product. The customer retains the master password, unlocked session and local
CLI account state. Do not expose unauthenticated `bw serve` publicly. The
bridge uses the signed remote protocol, a fixed customer-authorized scope,
isolated CLI state and an explicit locked/offline/reconnect lifecycle.
Refresh must include upstream `bw sync`, not merely reread its local cache.
Official CLI/source review: Bitwarden clients commit `57e52fcc`, CLI
2026.10.0. Run `bw serve` only on a private Unix socket under a 0700 directory,
not on TCP. Keep one account/appdata directory per bridge process. Do not
export login/unlock or arbitrary CLI commands over the remote protocol.
The bridge receives an already-unlocked customer-controlled CLI and reports
locked/unauthenticated states; operator login/unlock stays local.

Inventory has full item values inside the bridge; strictly project metadata
before transmitting. Sync before listing and writing, read current item,
compare revisionDate, merge field changes preserving unknown fields and edit
with the server's revision precondition. Permission fields and null hidden
values fail closed. Archive maps to recoverable trash, not Premium-only
archive or permanent deletion. First-wave attachment writes and top-level
vault creation remain unsupported until their distinct flows are covered.

## 14. Host-provided storage and human input

Remote sources support ordinary agent discovery, reference resolution and
capability-gated item writes. The current secret ask card persists a hosted
value and its answer in one DB transaction. External writes cannot simply be
inserted into that transaction: they need durable idempotency/reconciliation
and must not replay on transaction retry. Preserve the existing hosted-only
ask-card destination in this wave and document it prominently in embedding
guidance. The customer's own UI can collect directly into its remote vault;
agents can then discover/reference it, or save through capability-gated
secret_save. Do not claim all newly asked secrets are stored externally. An
external ask-card transaction coordinator is a separate future change, not
an implicit side effect of adding this provider interface.

## 15. UI/UX and review ownership

Opus owns UI/UX design and subsequent polish, using current real components
and `apps/web/DESIGN.md`. Preserve the current ownership/availability flow.
One provider chooser leads to provider-specific setup; connection detail
owns link/reconnect/disconnect. Explain only actionable requirements and
unsupported operations. Do not copy a service-account-token flow onto a
locked local vault or a one-time Keeper bootstrap.

Five passes are required: core journey/information architecture; complete
state/capability behavior; keyboard/accessibility; responsive and long-data
behavior; end-to-end regression/polish. Capture real components at desktop and
mobile widths in each pass, record defects and fix them. The completed Opus
design (04d2caef, result sequence 2549) is incorporated: one Connect chooser
and one Connections list; same 1Password pages remain reachable;
provider-specific requirement/renewal copy; no master-password field for
Bitwarden; visible read-only reasons rather than tooltip-only disabled Edit.
Healthy rows have no status badge. Unavailable with a mirror means "Showing
items from the last sync"; unavailable without one is not an empty vault.
Refresh offers one action and respects rate-limit retry time.

Fix these source-verified baseline pitfalls while generalizing: provider
archive toast cannot offer local Undo after resync deletes its mirror row;
provider history Restore has no working write path; provider editors must not
offer file writes; sync/error/source strings must not hardcode 1Password.
Move/copy does have a core cross-provider implementation despite stale docs:
keep supported copies, gate moves by recoverable source removal and valid
destination create capabilities, and correct the docs.
Cross-provider moves are not atomic: the original's provider version is read
fresh before its values are copied and checked again just before the
recoverable archive; a change, a missing item or a failed check keeps the
original (`saved: true`, `sourceArchived: false`). Without a provider
conditional archive, an edit between that check and the archive remains
possible, and unversioned providers get no check.

Review states: existing S1–S16, provider picker/disabled provider; empty/filled/
invalid/expired setup; one-time bootstrap failure; read-only/unknown grant
chooser; partial link failure; healthy/syncing/stale/never-synced/expired/
expiring/rate-limited/locked/offline/revoked inventory; read-only and writable
items; removal/unlink/disconnect; role restrictions and long names. Each pass
uses 1440×900, 834×1112 and 390×844, light and dark, with axe, overflow,
keyboard/focus and hit-target checks. Historical screenshots are not evidence
of the new implementation.

## 16. Verification and evidence

- Baseline focused suite: 72 tests passed, zero failed (contracts, vault
  package, provider sync and web type parity), Bun 1.4.0, October 15.
- Unit: wire bounds/signature parsing, pagination loops/scope, capability
  checks, field projection, TTL/cache bypass, safe errors, provider mappings.
- DB: new source/link invariants and existing Only-me/organization reach,
  owner-migrated non-superuser FORCE-RLS cases, stale mirror preservation,
  connection replace/revoke and cross-tenant denials.
- Integration: actual signed HTTP callback against a local customer fixture,
  hostile/redirect/oversize/delayed endpoints, revoked actors and unavailable
  upstream, writes with uncertain responses.
- Local full stack: setup/link/list/page/search/use/edit/refresh/reconnect/
  disconnect, shell/tool/browser reference delivery and TOTP where supported.
- Live vendor tests only when authorized test accounts exist. SDK/CLI fakes
  and fixtures are not live success. Record exact gaps without buying plans.
- Run relevant typecheck/lint/unit/DB/browser suites, wider regressions,
  public API compatibility and docs/Skill distribution tests before handoff.
- Independent Opus security/correctness review after implementation.

## 17. Work ownership and rollout

Parent owns shared contracts, integration, review and one focused PR. Workers
receive disjoint implementation files and their own worktrees after design
settles. Source branch stays stable across unrelated main advances; inspect
merge-tree compatibility without ritual rebasing. No merge/deploy in this task.

All repository work and evidence stay on `/workspace`. Use pinned Bun 1.4.0,
bounded build/test concurrency, unique service ports and task-owned processes.
Track cleanup in the task's ownership ledger.

## 18. Research evidence and implementation boundaries

Completed vendor research: worker 7cb432ea, result sequence 3742. Sources:

- https://protonpass.github.io/pass-cli/
- https://github.com/protonpass/pass-cli/tree/v2.4.2
- https://github.com/protonpass/proton-pass-common/tree/2.1.1
- https://proton.me/support/pass-access-tokens
- https://docs.keeper.io/keeperpam/secrets-manager/developer-sdk-library/javascript-sdk.md
- https://docs.keeper.io/keeperpam/secrets-manager/quick-start-guide.md
- https://docs.keeper.io/keeperpam/secrets-manager/about/secrets-manager-configuration.md
- Published `@keeper-security/secrets-manager-core` 17.6.0 source tarball.
- https://bitwarden.com/help/cli/
- https://bitwarden.com/help/personal-api-key/
- https://bitwarden.com/help/bitwarden-apis/
- https://github.com/bitwarden/clients/tree/57e52fcc/apps/cli

No saved test credentials matched Proton, Keeper or Bitwarden on October 15.
These findings are source-level, not live-account acceptance. Continue
implementation and isolated fixture/E2E verification; do not purchase plans
or claim live acceptance without evidence. Current 1Password fixtures remain
separately available. No native Connected Machine vault RPC exists today.

Shared implementation contract decisions: add optional paged methods to the
legacy port; use `VaultProviderOperations` for create/update/archive/delete,
create-vault, TOTP/file/history/move capabilities and supported creation types;
per-vault `writeAccess` is read-only, read-write or unknown. Add trusted
authority, cache epoch and force-refresh to call context. Remote request
version is `opengeni.vault.v1`, operation-discriminated and exact-body signed.
Receiver authorization is mandatory after signature verification. Registered
endpoints are fixed by the connection; value/list operations cannot override
them with per-call URLs. No automatic mutation retry.
