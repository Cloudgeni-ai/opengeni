# `@opengeni/vaults-onepassword`

The 1Password provider for Opengeni vaults. It implements `VaultProvider` from
`@opengeni/vaults` on a 1Password service account, using the pinned
`@1password/sdk` 0.5.0 (a WASM core of about 14 MB).

Load it only with a dynamic `import()` from the API or the worker; nothing
else may import it or the SDK (`test/import-guard.test.ts`).

What it does:

- **Reads values live.** Item values are fetched on demand (`items.get`) and
  cached per attempt for 60 seconds with single-flight. Vault and item metadata
  (names, types, websites and field descriptors, never values) can be listed
  for the metadata mirror.
- **Writes both ways.** It creates items (logins with generated passwords,
  API keys, notes, TOTP seeds), patches fields on update with an optional
  expected version (`provider_conflict` on a mismatch), and archives items.
- **Creates managed vaults**, with `allowAdminsAccess` and an optional group
  grant (not available on 1Password Families).
- **Maps errors.** The SDK's typed rate-limit and auth-expiry errors, and its
  message strings, map to `VaultProviderError` codes in one table.
- **Protects the quota.** Each connection has a per-process token bucket
  sized by plan (Families 1,000, Teams 5,000, Business 50,000 requests a day,
  plus the hourly read and write limits), charged by the measured HTTP cost of
  each SDK operation. A real 429 closes the connection until its retry time.
  Each agent attempt may make at most 50 provider reads.

`vaultProviderForOnePasswordConnection({ token, planTier, allowFakeTokens })`
checks a stored token offline and returns the provider. With
`allowFakeTokens` (the local-only `OPENGENI_ONEPASSWORD_FAKE_TOKENS` switch),
the tokens `ops_fake_healthy` and `ops_fake_sync_error` return an in-memory
fake instead.

Live tests run only on request (`OPENGENI_ONEPASSWORD_LIVE=1`, see
`test/live.test.ts`) and count every request against the account quota.
