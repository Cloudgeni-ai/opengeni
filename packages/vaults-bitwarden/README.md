# `@opengeni/vaults-bitwarden`

The Bitwarden provider for Opengeni vaults. It implements `VaultProvider`
from `@opengeni/vaults` against the Bitwarden client API, so it works with
Bitwarden Cloud (US and EU), self-hosted Bitwarden and Vaultwarden. There is
no CLI, bridge or helper process: the adapter signs in with the account's
personal API key and decrypts items itself.

The API and the worker load it with a dynamic `import()`.

## Connecting

A customer gives Opengeni a dedicated Bitwarden account (one per use is
best) and decides what it sees with ordinary Bitwarden sharing: the
account's own items ("My vault") and the organization collections it is a
member of. Setup takes four values:

- the server address (`https://vault.bitwarden.com`, `https://vault.bitwarden.eu`
  or a self-hosted one),
- the personal API key's `client_id` (`user.…`) and `client_secret`
  (Settings, Security, Keys, View API key),
- the account's master password, used once.

```ts
const bitwarden = await import("@opengeni/vaults-bitwarden");
const { credentials, accountName } = await bitwarden.connectBitwarden(
  { serverUrl, clientId, clientSecret, masterPassword },
  { fetch },
);
// Store `credentials` encrypted. They hold the API key, the server's
// addresses and the account's user key, never the master password.
const provider = bitwarden.createBitwardenVaultProvider({ credentials, fetch });
```

Setup reads the server's `/api/config`, refuses API or identity addresses on
another site (so the API key only goes to the server the customer entered),
signs in with the API key, reads the account's key settings, derives the
master key (PBKDF2 or Argon2id) and opens the account's user key with it.
The master password and master key are dropped right after. An organization
API key is refused with a message that names the personal one.

## Vaults and items

- **Vaults.** "My vault" (`externalVaultId` `personal`) and one vault per
  collection the account can open, read-only when the collection is. A
  member whose organization membership is not confirmed yet sees My vault
  only, and listing a collection there says an owner must confirm it.
- **Items.** Logins and secure notes, with cards, identities and SSH keys
  listed by their fields. Built-in fields (username, password, one-time
  password and so on), notes, text, hidden and boolean custom fields, and
  attachments (read as files). Item keys and organization keys are handled.
  A hide-passwords collection lets the account use an item's plain fields
  but refuses its concealed fields, one-time passwords and files.
- **Writes.** Creates logins and notes in My vault or a writable collection,
  patches fields, and moves items to Bitwarden's trash (restorable there).
  Updates carry the revision they were read at, so a write that raced
  another client is `provider_conflict`, not a silent overwrite.

## Freshness and caching

Values are never cached: every read fetches the item and decrypts it. One
`/sync` per attempt backs listing, and each vault's change token is a hash
of its items' ids and revision dates, so the metadata mirror updates only
when something changed. Access tokens are reused per API key until shortly
before they expire, since sign-in is the rate-limited call; a token the
server stops accepting is replaced once.

## Errors

Server answers map to the shared `VaultProviderError` codes: a refused API
key or master password is `provider_auth_invalid`, a signed-out session
`provider_auth_expired`, 429 `provider_rate_limited` with the server's retry
time, a 5xx during a write `provider_outcome_unknown`. A user key that no
longer opens the account (its encryption key was rotated) asks for a
reconnect. Accounts on Bitwarden's newer XChaCha20 key format are not
supported yet and say so.

## Tests

`test/fake-server.ts` is a wire-level fake of the client API that stores
ciphers encrypted the way clients write them; `test/provider.test.ts` runs
the shared provider contract and the Bitwarden specifics against it. The
contract also runs against a real account behind `OPENGENI_BITWARDEN_LIVE=1`
(`test/live.test.ts` lists the variables). Use a dedicated test account.
