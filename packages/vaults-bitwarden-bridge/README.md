# `@opengeni/vaults-bitwarden-bridge`

A customer-run bridge that lets Opengeni use a Bitwarden Password Manager
account as an external vault. It speaks Opengeni's signed remote vault
protocol (`opengeni.vault.v1`) to Opengeni and talks to an already-unlocked
`bw serve` over a private Unix socket on the same machine.

It is not for Bitwarden Secrets Manager, which is a separate product.

The bridge is checked against the Bitwarden CLI source at
`bitwarden/clients` commit `57e52fcc` (CLI 2026.10.0). Its tests run against a
fixture `bw serve` that follows that source. It has not been run against a
live Bitwarden account.

## What stays with the customer

- The master password, the unlocked session (`BW_SESSION`) and the CLI app
  data never leave the machine. Opengeni never collects or sees them.
- The bridge never logs in, unlocks, locks or runs arbitrary `bw` commands,
  and the protocol has no route for any of these. When the vault is locked or
  logged out, Opengeni sees `provider_locked` or `provider_auth_expired` and
  the operator fixes it locally.
- `bw serve` never listens on TCP. It runs on a Unix socket in a `0700`
  directory, with its own `BITWARDENCLI_APPDATA_DIR`, one per Bitwarden
  account.

## Setup

1. Create private directories for this account (all `0700`, owned by the
   bridge user):

   ```sh
   install -d -m 0700 /srv/opengeni-bw/appdata /srv/opengeni-bw/run /srv/opengeni-bw/state
   ```

2. Log in and unlock in your own terminal, then start `bw serve` on the socket:

   ```sh
   export BITWARDENCLI_APPDATA_DIR=/srv/opengeni-bw/appdata
   bw config server https://vault.bitwarden.com   # or your EU / self-hosted server
   bw login
   export BW_SESSION="$(bw unlock --raw)"
   bw serve --hostname unix:///srv/opengeni-bw/run/bw.sock
   ```

   `bitwardenServeCommand()` returns this argv and environment after checking
   the directories. Keep origin protection on (do not pass
   `--disable-origin-protection`). If you pass `--port` to `bw serve`, set the
   same value as `bwServePort` so the bridge sends the matching `Host` header.

3. Create the connection in Opengeni (provider: Bitwarden). Store the signing
   secret Opengeni shows in a `0600` file on this machine.

4. Write the bridge config (no secrets in the JSON):

   ```json
   {
     "connectionId": "<Opengeni connection id>",
     "signingSecretFile": "/srv/opengeni-bw/signing-secret",
     "opengeni": {
       "accountId": "<Opengeni account id>",
       "connectionWorkspaceId": "<workspace that owns the connection>",
       "workspaceIds": ["<workspaces allowed to use it>"],
       "subjectIds": "any"
     },
     "vaults": [
       { "kind": "personal", "mode": "read_only" },
       {
         "kind": "collection",
         "organizationId": "<org id>",
         "collectionId": "<collection id>",
         "mode": "read_write"
       }
     ],
     "bwSocketPath": "/srv/opengeni-bw/run/bw.sock",
     "stateDir": "/srv/opengeni-bw/state",
     "listen": { "host": "127.0.0.1", "port": 8788 }
   }
   ```

   `OPENGENI_VAULT_SIGNING_SECRET` can be used instead of `signingSecretFile`.
   During rotation, add `previousSigningSecretFile` until Opengeni uses the new
   secret.

5. Run it and publish it through your own TLS reverse proxy, forwarding
   `POST /opengeni/vault` unchanged (the signature covers the exact body):

   ```sh
   opengeni-bitwarden-bridge --config /srv/opengeni-bw/bridge.json
   ```

   The listener accepts only loopback addresses (or `listen.path` for a Unix
   socket) unless you set `allowNonLoopback`. Every request is authenticated
   by its signature, never by network position. There is no unauthenticated
   health, unlock or command route; `bridge.health()` is for local use only.

## Scope and authorization

- One bridge process serves one Bitwarden account and one fixed inventory:
  the vaults in `vaults`. The personal vault is `personal`; a collection is
  `collection:<collectionId>`. Items outside a configured vault are never
  listed, read, changed or trashed, and the same inventory is returned
  whoever is asking.
- Every request must name this connection, this Opengeni account and the
  owning workspace. The calling workspace must be in `workspaceIds` (default:
  only the owning workspace). With a `subjectIds` list, only those acting
  subjects can read values, write or trash; inventory listings are allowed.
- A valid signature is not authorization. Embedders building their own
  receiver with `@opengeni/sdk/external-vault-receiver` map Opengeni's
  account, workspace and subject to their own tenant and user in
  `authorize` on every request.

## Freshness

- Listings, refreshes and writes run `POST /sync?force=true` upstream first,
  reusing a bridge sync newer than `minSyncIntervalMs` (15 seconds) for
  listings and refreshes. Writes always sync first.
- Reads resync when the last bridge sync is older than `readSyncTtlMs`
  (5 minutes), or on a deliberate refresh.
- Freshness reports Bitwarden's own `lastSync`. If the upstream sync fails
  (offline, server error), reads and listings are served from the CLI cache
  marked `stale`; set `allowStaleReads: false` to fail instead. Writes never
  run on a stale cache.
- Locked and logged-out CLIs are reported as such, not as empty vaults.
  A collection that disappears is absent from the vault list, not empty.

## What is sent

`bw serve` listings contain decrypted values. The bridge projects each item
to metadata (name, type, websites, field names and kinds, revision date)
before responding. Values leave the bridge only in `read_fields` responses,
for exactly the requested fields.

| Bitwarden | Opengeni field id | Kind |
| --- | --- | --- |
| Login username | `login.username` | text |
| Login password | `login.password` | concealed |
| Login TOTP (valid seeds only) | `login.totp` | totp |
| Notes | `notes` | text |
| Custom text / boolean field | `field:<name hash>:<occurrence>` | text |
| Custom hidden field | `field:<name hash>:<occurrence>` | concealed |

Login items map to `login`; every other type is shown as a read-only `note`.
Linked custom fields are not exposed. When Bitwarden hides a value from this
user (no view-password permission, so the CLI returns `null`), the field is
left out of metadata and a read is `provider_permission_denied`.

## Writes

- Creates support `login` and `note` items, in the personal vault or the
  configured collection.
- Updates sync, read the current item, compare `revisionDate` with the
  expected version, then send the whole current item with the changes
  (unknown properties, URI match settings, password history and linked
  fields are kept). The server refuses the edit if the item changed since.
- Archive is Bitwarden's ordinary delete, which moves the item to Trash,
  recoverable for 30 days. The bridge never deletes permanently and does
  not use Premium archive.
- The CLI does not expose per-user collection or item edit permissions, so
  collection write access is reported as `unknown`, and Bitwarden's own
  refusal is returned as `provider_permission_denied`.
- Mutations are claimed in the durable state directory under their
  idempotency key. A repeated key returns the recorded result; nothing is
  retried automatically. If `bw serve` fails after a change may have been
  made, Opengeni gets `provider_outcome_unknown` and should check the vault
  before trying again. Rotating the signing secret makes keys claimed before
  the rotation report a conflict when reused.

## Not supported in this version

- Attachments (reading or writing files), passkeys, creating vaults or
  collections, restoring from Trash, permanent delete and Premium archive.
- Logging in, unlocking or starting `bw` remotely.
- Saving answers from Opengeni's secret ask card into Bitwarden. The ask card
  still stores answers in Opengeni-hosted vaults. Collect secrets in your own
  UI or with Bitwarden directly; agents can then find and reference them, or
  save through `secret_save` where the connection allows writes.
- Several bridge processes sharing one state directory. Use one process per
  account, or a database-backed `ExternalVaultReceiverStore`.

## Library use

```ts
import {
  BitwardenServeClient,
  createBitwardenBridge,
  createFileExternalVaultReceiverStore,
  createUnixSocketBitwardenTransport,
  serveBitwardenBridge,
} from "@opengeni/vaults-bitwarden-bridge";

const bridge = createBitwardenBridge({
  config,
  client: new BitwardenServeClient({
    transport: createUnixSocketBitwardenTransport({ socketPath: "/srv/opengeni-bw/run/bw.sock" }),
  }),
  store: createFileExternalVaultReceiverStore({ directory: "/srv/opengeni-bw/state" }),
});
await serveBitwardenBridge({ bridge, listen: { host: "127.0.0.1", port: 8788 } });
// Or mount it in an existing server: bridge.fetch(request) / bridge.handle({ body, headers }).
```
