# Connected and externally hosted vaults

Connected vaults use the [native secrets model](secrets.md): the same ownership,
availability, references, paginated discovery and execution-time resolution.
They are not a second environment-variable system. Opengeni mirrors names,
websites and field metadata, never item values. Some providers require a full
item fetch/decryption to discover its fields; those values stay inside the
adapter, not in the mirror or listing result. References resolve values at
execution time. Connection credentials are encrypted separately from the mirror.

## Choose the connection

| Source | Access path | First-wave boundaries |
|---|---|---|
| 1Password | Service-account token and official SDK | Existing connection routes remain supported. |
| Proton Pass | Scoped personal access token and operator-installed official CLI | Create supported items and move them to Trash; no updates, field removal, vault creation or file uploads. |
| Keeper Secrets Manager | One-time token exchanged for bound SDK configuration | Shared folders are vaults; create and update supported records; no Archive or permanent-delete action. |
| Bitwarden Password Manager (bitwarden.com, bitwarden.eu, self-hosted, Vaultwarden) | The account's personal API key plus its master password once, over the server's client API; decrypted inside Opengeni | My vault and each organization collection the account can open are vaults; read every item type; create logins and notes; update logins, notes, cards and identities; move items to Trash; no file uploads. Not Bitwarden Secrets Manager. |
| External vault | Signed remote provider implemented by the embedding product | One connection can expose several vaults, with explicit operation capabilities. |
| In-process host | Existing `connectionCredentials.vaultProvider` port | Remains supported; no remote endpoint is required. |

Do not infer every operation from a generic read-write label. Provider and
vault capabilities are intersected with the linked mode and current native
authority. `writeAccess: unknown` means upstream does not expose its grant;
it does not certify write permission. Upstream can still refuse an operation.

Proton updates are intentionally unavailable: the supported CLI accepts update
values in process arguments rather than a safe stdin payload. A password or
TOTP seed must not enter a process listing to make an Edit button work. Keeper's
SDK does not expose a documented recoverable archive operation, so its Delete
API is not substituted for the product's Archive action.

For Proton Pass, the operator installs the supported `pass-cli` binary and sets
`OPENGENI_PROTON_PASS_CLI_PATH` to its absolute path in both API and worker
environments. The adapter checks the version; Opengeni does not download or
redistribute the binary automatically. No configured binary means Proton Pass
is unavailable in that deployment, not that the user's token is wrong.

### Bitwarden and Vaultwarden

Bitwarden needs nothing installed. Opengeni talks to the server's client API
the way the official apps do and decrypts items itself:

- **Setup** takes the server address, the account's personal API key
  (Settings, Security, Keys, View API key: a `user.…` client ID and its
  secret) and the master password. The master password opens the account's
  user key once and is then discarded. Opengeni stores, encrypted, the API key,
  the server's API and identity addresses and the user key. Changing the master
  password later keeps working; rotating the account's encryption key needs a
  reconnect. An organization API key is refused: it cannot read a vault.
- **Vaults** are My vault and every organization collection the account can
  open. A collection shared read-only refuses writes; one that hides passwords
  refuses concealed values, one-time passwords and attachments.
- **Values** are never cached. Each read asks the server for the item and
  decrypts only the requested fields. Listing uses one encrypted sync per
  attempt. Access tokens are reused per process until shortly before they
  expire, because servers rate-limit logins.
- **Item types.** Logins, secure notes, cards, identities and SSH keys are all
  readable. A login is an Opengeni login with its websites, username, password
  and one-time password; the other types are Opengeni notes whose fields are
  the type's own (a card's number and security code, an identity's email or
  passport number, an SSH key's private key, public key and fingerprint),
  followed by notes, custom fields and attachments. Concealed Bitwarden values
  stay concealed. Linked custom fields hold no value of their own and are not
  listed.
- **Writes** create logins and secure notes, update any item's name, notes and
  custom fields, update and remove the own fields of logins, cards and
  identities, and move items to Trash, where they can be restored. A new field
  named like an empty built-in one (for example `security code` on a card)
  fills it. Every update starts from the item's current encrypted copy and
  sends back what it does not change as the same ciphertext, so passkeys,
  attachments, password history, website match rules, linked fields, folder,
  favorite and master-password re-prompt survive; a changed password is added
  to the password history. The update names the revision it started from, and
  the server refuses it if the item changed in between. An item keeps its
  owner: an organization item stays in its organization and collections, and
  a new item in a collection is created there under the organization's key.
  An SSH key's own fields, an item's type and attachments are changed in
  Bitwarden itself (Bitwarden derives an SSH key's public key and fingerprint
  from its private key).
- **Changes made elsewhere.** Values are read live, so a changed password is
  used on the next call. Names and fields follow the
  [freshness rules](#freshness-three-different-things): a cheap revision check
  refreshes them when browsing or searching after ten minutes, after two
  minutes when a reference finds nothing, and at once on Refresh.
- **Self-hosted servers** on a private network address need
  `OPENGENI_INTEGRATIONS_ALLOW_PRIVATE_NETWORK_TARGETS=true` in both API and
  worker; every request is otherwise DNS-pinned to public addresses. The
  server's `/api/config` may name API and identity hosts only on the same
  site as the address entered.

Give agents an account of their own: they can use everything the connected
account can open. Invite that account to an organization, share only the
collections agents need with it, and connect it, not a person's account. A
collection shared with "hide passwords" lets agents use usernames but not
passwords or one-time passwords; read-only collections refuse writes; and
items or fields marked "ask me each time" in Opengeni need the owner's
approval on every use (see [Approval for each use](secrets.md#approval-for-each-use)).
Removing the account from a collection takes effect at the next refresh;
values from it stop resolving at once.

Not supported yet, and why:

- **Bitwarden Secrets Manager** (machine accounts and access tokens) is a
  separate product with its own API and data model. It would be a separate
  provider; this one covers Password Manager accounts.
- **Accounts without a master password** (single sign-on with trusted devices
  or Key Connector) cannot be opened with an API key, because the user key is
  never derivable from a password.
- **Accounts on Bitwarden's newer XChaCha20 key format** are refused at setup
  with a clear message. Servers and clients have not rolled it out widely, and
  supporting it needs a vetted XChaCha20-Poly1305 implementation.
- **Keeping the unlocked vault on a person's own machine**, with Opengeni
  asking that machine for each value, would avoid giving Opengeni the master
  password once. It needs a local agent that stays unlocked and online, so it
  is left for a later provider; a dedicated agent account shared through
  collections covers unattended agents today.
- **Push updates** from the server's notification hub would show changes made
  elsewhere within seconds instead of minutes. They need a long-lived socket
  per connection; values are already read live, so only names and new items
  wait for the next refresh.
- **Creating cards, identities and SSH keys, and uploading attachments.**
  Opengeni has no card, identity or SSH key item type to create from, and
  attachments are uploaded in Bitwarden itself.

## Connection lifecycle

Use Vaults' Connect action or `vaultsApi(client, workspaceId)` from
`@opengeni/sdk`. Existing 1Password setup methods remain unchanged. New sources
use `installVaultProvider` with explicit ownership and write-only credentials:

```ts
import { vaultsApi } from "@opengeni/sdk";

const vaults = vaultsApi(client, workspaceId);
const connection = await vaults.installVaultProvider({
  ownership: "user",
  label: "Product account",
  credentials: {
    provider: "external",
    endpoint: process.env.PRODUCT_VAULT_ENDPOINT!,
    signingSecret: process.env.PRODUCT_VAULT_SIGNING_SECRET!,
  },
});
// This code belongs on your server, never in browser code or model context.
```

Setup credentials are provider-specific:

- `external`: `endpoint` and `signingSecret`.
- `bitwarden`: `serverUrl`, `clientId`, `clientSecret` and `masterPassword`
  (used once, never stored).
- `protonpass`: `token` (a scoped personal access token, not the account password).
- `keeper`: `oneTimeToken`, optionally its region `hostname`.

An Only-me connection can back only its owner's Only-me vaults. Shared
workspace and organization connections retain their corresponding ownership;
organization setup requires `account:admin`. Setup and reconnect use the
existing `connections:write` and `secrets:write` gates and current ownership
checks. Authorized agent attempts can manage shared connections through the
same gates; Only-me setup still requires the verified personal-owner principal.

Setup reserves a connection identity before contacting upstream. Keeper's
successful token binding is saved encrypted immediately; the bootstrap token
is not retained as the runtime credential. If verification or listing fails
after credentials were saved, the response is `202` with
`discoveryPending: true`. The connection is shown as pending rather than
forcing another bootstrap. Call `verifyVaultProviderConnection(connectionId)`
to continue with the saved credentials. Pending initial connections cannot
resolve values or be linked. A pending reconnect preserves the previously
working credential until the new one has been checked.

`getVaultProviderCatalog()` adds deployment availability for every provider,
including when no connections exist yet. Use it to disable unsupported setup
choices before collecting credentials. `listVaultProviderConnections()` is
metadata-only and includes 1Password. It does not resolve item values or
refresh the providers. `listProviderVaults()`
contacts the connection to discover its available vaults. Link the chosen
vaults with `linkProviderVault()`; each link keeps the existing availability
controls. A reconnect refuses an unexpected upstream account change.

Disconnecting removes local links and revokes stored access. It never deletes
a password-manager vault, account or item.

## Freshness: three different things

1. **Opengeni's inventory:** names and fields mirrored for search and browsing.
2. **The provider's inventory:** live upstream data, or a bridge's synchronized
   local cache. A local cache check is not an upstream sync.
3. **Resolved values:** fetched when references execute; an adapter may keep a
   short, attempt-scoped value cache. They are not copied to the metadata mirror.

Automatic metadata refresh is usage-driven, not a continuous background sync.
The normal thresholds are ten minutes for browsing/search and two minutes
after a reference misses. Explicit Refresh also invalidates value caches
across API and worker processes. It does not replay a dispatched command or
ignore a rate-limit retry time.

Freshness reports distinguish `lastCheckedAt` from `sourceSyncedAt`, and
`live`, `cache` or `unknown` source data. Stale/refreshing/unavailable states
must not be rendered as a healthy empty vault. An expired token, locked
bridge, partial traversal or provider outage keeps the previous mirror and
reports the failure. Search returns `complete: false` when a relevant source
cannot be checked. It does not manufacture a missing-secret question from
that failure. An explicitly named healthy vault can still be used when an
unrelated provider is unavailable.
A miss checks the connected vaults that could change the answer: every
connected vault at or above the priority tier that matched (task, Only me,
workspace, organization). A hosted workspace item without a one-time password
therefore does not stop an Only-me connected vault from being refreshed, and
an outage in a lower-priority vault does not hide a miss decided above it.

Provider pages are bounded and checked for duplicate IDs, repeating cursors,
snapshot changes and excessive counts. Only a full consistent traversal may
remove absent mirror rows: multiple pages must carry one stable non-null
snapshot. The native limit remains 2,000 items per vault; the first 2,000 of a
larger inventory are never certified as complete.
Overlapping syncs settle the mirror, capabilities, status and freshness
atomically against the cache epoch captured before provider I/O. Once one
check settles, a late result from the same epoch is superseded and cannot
overwrite it, even with a failure or an unchanged listing. This is
first-settlement-wins, not ordering of opaque provider versions; a later
deliberate sync checks the provider again.

## Moving and copying

Copying requires the destination to support the item's type and fields.
Moving also requires recoverable removal at the source. These operations
are not a transaction across providers. For a versioned connected source,
Opengeni first checks that its synced field list matches the provider's current
item version; otherwise nothing is moved, and the vault must be synced before
trying again. It checks the version again after saving the copy, before
archiving the original. A changed version or failed recheck
keeps the original and reports `saved: true`, `sourceArchived: false`; compare
the two items rather than repeat the move. Providers without item versions
cannot offer this check, and an edit after the final check remains a race
because the archive operation is not conditional. The original is recoverable
in its provider's archive or Trash. These checks are not an atomic read and
depend on the provider reporting fresh versions for every field change.

## A product that owns its users' passwords

Implement the remote vault protocol rather than returning stored passwords
through the run-credential callback. The remote endpoint may expose multiple
vaults. It returns metadata for listing, values only for requested fields,
and only the write operations it can actually honor.

The signed request carries the native account, workspace, connection and
acting subject, plus available attempt or Site context. Verify the signature
over the exact raw body, then map those identities to your own tenant and user
and authorize every operation. A valid signature is not permission to read
any tenant's vault. Metadata inventories have a fixed sharing scope per
connection; use separate user-owned connections for different users' stores.
Never combine user-dependent results in one shared metadata mirror.

Keep the endpoint and signing key server-side. Production endpoints require
HTTPS, pinned outbound DNS, bounded requests and responses, and no redirects.
Private targets require an explicit operator policy, not an agent-provided URL.
Do not blindly retry a timed-out write: the provider may have completed it.
Use operation identity and durable idempotency/reconciliation at the host.
The receiver deduplicates repeated mutation keys, not separate user or agent
save requests. Ordinary new save requests currently get new keys; after an
unknown outcome, inspect the vault before issuing another save. This is not
an exactly-once guarantee across separate API calls.

Connection managers with the existing connection and secret write permissions
may replace remote endpoints and signing keys. A receiver's account ID is
self-reported continuity metadata, not independent proof of who operates the
endpoint. Treat connection-management authority as authority to choose the
service that receives writes and supplies values.

### Implement the receiver

The server-only `@opengeni/sdk/external-vault-receiver` subpath supplies
`createExternalVaultReceiver`. It verifies raw-body signatures, signs responses,
rejects replayed requests, projects metadata without values, and
claims writes through your durable idempotency store. Do not implement a
second signature format or import this helper into browser code.

Provide three pieces:

- `resolveConnection(connectionId)` loads the signing keys and fixed host
  tenant/inventory for that connection. Bind the native `accountId` and
  `connectionWorkspaceId` as well; do not select a tenant from unchecked
  request metadata.
- `authorize({ connection, authority, operation })` maps the verified native
  person to your user and checks current access for this operation. Return
  `null` to deny it. Inventory handlers intentionally receive only the fixed
  connection scope, not that person's principal.
- `handlers` implement `describe`, `listVaults`, `listItems` and `readFields`,
  with optional `refresh`, `writeItem` and `archiveItem`. Return bounded pages
  and explicit capabilities. Use `ExternalVaultReceiverError` for safe,
  structured refusals; raw backend errors are not sent to Opengeni.

For a multi-page inventory, return the same non-null snapshot token on every
page and keep the traversal consistent with that snapshot. A single page may
omit it. Un-snapshotted multi-page discovery remains enumerable, but Opengeni
refuses to replace its mirror from it and reports an incomplete inventory.

Mount `receiver.fetch(request)` in your server route, or pass the untouched
body and headers to `receiver.handle`. Choose a durable implementation of
`ExternalVaultReceiverStore`: its replay and mutation claims must be atomic
across all replicas. `createInMemoryExternalVaultReceiverStore` is for local
tests only, not production writes.

If your receiver needs the new native connection ID before accepting its
first request, use the pending setup flow: `installVaultProvider` saves the
encrypted key and returns the ID with `discoveryPending: true`; register that
ID against your fixed host tenant/user, then call
`verifyVaultProviderConnection`. Do not solve registration by accepting every
unknown connection into one shared tenant.

The source-level receiver examples and tests live in
`packages/sdk/test/external-vault-receiver.test.ts`.

The native secret ask card still saves atomically to hosted vaults only. A
host can collect a secret in its own UI and then expose the resulting item
through its vault provider. This first wave does not turn the ask card into
a distributed remote write transaction.

## Renewable run credentials stay separate

The [credential-provider callback](workspace-integrations.md) mints and renews
credentials for a specific session or attempt. It also carries transport
bindings such as Git authentication and MCP authorization headers. A stored
vault item may contain a token, and references can supply an environment
variable or a file, but this does not replace provisioning, expiry, renewal,
reconnect or cleanup. Keep that lifecycle when the host needs it; use vaults
for discoverable stored items. Neither mechanism grants authority beyond the
acting native caller.
