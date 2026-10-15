# `@opengeni/vaults-keeper`

The Keeper Secrets Manager (KSM) provider for Opengeni vaults. It implements
`VaultProvider` from `@opengeni/vaults` on a KSM application, using the
official `@keeper-security/secrets-manager-core` pinned to exactly 17.6.0.

Load it only with a dynamic `import()` from the API or the worker. Nothing
else may import it, and nothing may import the SDK as a module
(`test/import-guard.test.ts`).

## Connecting: one-time token to configuration

A customer creates a KSM application, shares folders with it and generates a
one-time access token (`US:…`, `EU:…` and so on). The first request redeems
the token and binds a key pair; the result is the connection's credential.

```ts
const keeper = await import("@opengeni/vaults-keeper");
const { configuration, accountName } = await keeper.bootstrapKeeperConfiguration({
  oneTimeToken, // hostname is needed only for a token without a region prefix
  persistConfiguration: async (configuration, { previous, reason }) => {
    // reason "bind", previous null: store it encrypted before anything else runs
  },
});
const provider = keeper.createKeeperVaultProvider({
  configuration, // or the stored string record
  persistConfiguration: async (next, { previous }) => {
    // compare-and-swap the stored, encrypted configuration from `previous` to `next`
  },
});
```

`bootstrapKeeperVaultProvider(options)` does both and returns
`{ provider, configuration, accountName }`. It requires
`persistConfiguration` and awaits it with the bound configuration before
returning, so a later validate or list failure cannot lose a spent token's
credential.

- **Redeem once, save at once.** As soon as Keeper has bound the key pair,
  the configuration is passed to `persistConfiguration` (`previous: null`,
  `reason: "bind"`), even if something after the bind failed. If that save
  fails, bootstrap reports `provider_unavailable` (without the configuration)
  and the customer generates a new token. A lost bind response is
  `provider_outcome_unknown` and is never retried. A definite refusal is
  `provider_auth_invalid`. If the application is IP-locked, the first request
  locks it to the Opengeni egress address.
- **Configuration.** JSON, base64 JSON (as Keeper tools export it) or a
  string record. The adapter emits canonical JSON of a string record, with
  binary entries in base64; `keeperConfigurationRecord()` returns the record
  for structured storage. Only the known keys are kept; `hostname`,
  `clientId`, `privateKey` and `appKey` are required. The host must be on
  `allowedHosts` (default `KEEPER_REGION_HOSTS`: US, EU, AU, GOV, JP, CA and
  IL5), checked before every request.
- **Rotation.** When the server rotates its key, the SDK changes the
  configuration and the adapter awaits `persistConfiguration` (`reason:
  "rotation"`, `previous` the last saved value). If that fails,
  the change stays pending and is persisted first on the next call, and the
  read fails with `provider_unavailable` (a write that already happened still
  succeeds). `currentConfiguration()` returns the latest value.

Other options: `allowedHosts`, `requestTimeoutMs` (default 15 s),
`valueCacheMs`, `operations` (the operations verified at setup; the provider
narrows to them and refuses the rest before any request) and `fetch`. Servers
pass a DNS-pinned `fetch` (the API and worker use `pinnedFetch` from
`@opengeni/network`); both the KSM transport and file downloads use it and
still apply the caller's abort signal, deadline, size bound and no-redirect
rule. `queryFunction`, `fetchFile`, `sdk` and `now` exist for tests.

Servers usually call `openKeeperConnection({ credentials, persistConfiguration,
operations, fetch })` instead. `credentials` is either `{ oneTimeToken,
hostname? }` or `{ configuration }` (a string record or JSON), and
`persistConfiguration(record, { reason })` is required: without it the call
refuses before any request. It returns `{ provider, configuration }`, the
bound configuration as a string record, never the token.

## How it uses the SDK

The SDK keeps its keys in module-global state and, by default, can write its
configuration and a response cache to disk. So the adapter never imports it
as a module. `createKeeperSdkLoader` reads the SDK's `dist/index.cjs.js`,
checks it against `KEEPER_SDK_SHA256`, and evaluates a fresh copy for every
operation:

- each operation has its own key cache, so connections in one process never
  share key material;
- `fs` is a stub with constants only, and `https` and `os` are empty, so the
  SDK cannot touch disk or open its own connections;
- configuration lives only in an in-memory store per operation;
- requests go through the adapter's transport: POST only, no redirects, a
  deadline and abort, and responses of at most 32 MB;
- SDK console output is captured, bounded and never forwarded. Records the
  SDK skips because they cannot be decrypted make a listing
  `provider_inventory_incomplete`.

Bundlers must keep `@keeper-security/secrets-manager-core` as an installed,
external package: the loader resolves and reads its file at run time.

Each operation is charged to the attempt's call budget, and operations for
one connection are serialized. Throttling is reported at once as
`provider_rate_limited` with Keeper's retry hint.

## What it can do

Vaults are the application's **shared folders**. Records shared directly to
the application, outside a shared folder, are not listed. Subfolders are
part of their shared folder.

| Operation | Supported | Notes |
| --- | --- | --- |
| List vaults | yes | Shared folders; `writeAccess` is `"unknown"` because KSM does not report it. |
| List items, read values | yes | Values read live, cached per attempt; `forceRefresh` bypasses the cache. |
| Read files | yes | Size-checked, downloaded over HTTPS and decrypted in memory, at most 256 KiB. |
| Create | login, note | In an existing shared folder. API key, file and passkey items are refused before any request. |
| Update | yes | Field patch with the record revision as the version; a stale version is `provider_conflict`. Standard fields are emptied, custom fields removed. Structured fields (cards, bank accounts, key pairs, security questions) cannot be patched. |
| TOTP | create and update | `oneTimeCode` fields. |
| Archive, delete | **no** | KSM can only delete permanently, which the adapter does not expose. |
| Create vault, write files | no | |

Read-only shared folders and other permission checks are enforced by
Keeper; a refused write is `provider_permission_denied`. A write whose
response is lost is `provider_outcome_unknown` and is never retried.

Field ids: `f:<type>` (standard fields), `c:<label or type>` (custom
fields), `@notes` and `@file:<fileUid>`, with `#n` on repeated names.
Records report their revision as the version and no update time.

## Testing

`bun test` runs against `test/fake-ksm.ts`, a fake KSM server that speaks
the wire protocol with real cryptography (key binding, AES-GCM and CBC,
ECDSA request signatures and key rotation). It covers the shared provider
contract (read side), bootstrap, configuration rotation and persistence
failure, reads, writes, permissions, conflicts, lost responses, throttling,
budgets, aborts and SDK isolation.

No live Keeper account was used. Request shapes come from the SDK source;
the error bodies for throttling, permissions and revision conflicts follow
the SDK's handling and Keeper documentation and are not verified live.
