---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Connected 1Password vaults work again and stay current on their own.

- The API and worker images ship the 1Password SDK as a real package. Bundling it left its WASM core behind, so every 1Password connect, sync and read failed with a generic error.
- An Only-me vault's personal 1Password token now loads in every workspace the vault reaches, not only the one it was added in. Before, using or syncing it elsewhere marked the vault "expired, reconnect 1Password" for everyone. Organization vaults likewise load their organization connection in every workspace they are available in.
- Linked vault mirrors refresh themselves: agent secret search refreshes mirrors older than 10 minutes, and a reference that finds nothing refreshes mirrors older than 2 minutes and looks again. Each refresh is one provider call (plus an item listing only when the vault changed), honours provider rate limits, and retries a failing vault at most once per period.
