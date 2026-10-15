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
| Bitwarden Password Manager | Customer-controlled signed bridge to the unlocked official CLI | Not Bitwarden Secrets Manager; customer keeps the master password and unlock session. |
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

- `external` and `bitwarden`: `endpoint` and `signingSecret`.
- `protonpass`: `token` (a scoped personal access token, not the account password).
- `keeper`: `oneTimeToken`, optionally its region `hostname`.

An Only-me connection can back only its owner's Only-me vaults. Shared
workspace and organization connections retain their corresponding ownership;
organization setup requires `account:admin`. Agent attempts cannot redirect a
connection endpoint, install credentials, or reconnect themselves.

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

Provider pages are bounded and checked for duplicate IDs, repeating cursors,
snapshot changes and excessive counts. Only a full successful traversal may
remove absent mirror rows. The native limit remains 2,000 items per vault;
the first 2,000 of a larger inventory are never certified as complete.

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
unknown connection into one shared tenant. A customer-controlled Bitwarden
bridge follows this same registration flow.

The source-level receiver examples and tests live in
`packages/sdk/test/external-vault-receiver.test.ts`; the customer-run bridge
and its configuration are documented in
`packages/vaults-bitwarden-bridge/README.md`.

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
