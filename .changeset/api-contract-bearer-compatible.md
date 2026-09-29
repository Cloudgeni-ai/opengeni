---
"@opengeni/api-router": patch
"@opengeni/sdk": minor
---

The `x-opengeni-api-contract` fence is now a stale-browser-tab guard only.
Cookie-authenticated (and unauthenticated local) mutations still need the exact
revision and receive `409 API_CONTRACT_CHANGED` otherwise, but
bearer-authenticated callers (API keys, delegated tokens) are admitted with an
older revision or none, so a backend pinned to an older `@opengeni/sdk` keeps
working across deployments. A truly breaking revision can still be refused for
every caller through `REFUSED_API_CONTRACT_REVISIONS`. The SDK gains an
`apiContract: "strict" | "compatible"` option: it defaults to `"strict"` only for
a browser client without an `apiKey`, and otherwise no longer throws
`OpenGeniApiContractMismatchError` from `getClientConfig()` or responses when
the API advertises a newer revision.
