---
"@opengeni/vaults-onepassword": patch
---

A server that cannot load the 1Password SDK (for example an image missing its WASM core) now reports `provider_unavailable` with a plain reason, instead of an unhandled error that surfaced as a generic 500. Connecting and syncing then say what is wrong, the vault records it as its sync status, and the next call tries to load the SDK again.
