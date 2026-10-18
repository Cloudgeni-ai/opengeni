---
"@opengeni/config": patch
"@opengeni/runtime": patch
---

The e2b sandbox backend now works and can point at any E2B-compatible API. The E2B SDK (2.56.0) is installed, and the API key, now with `OPENGENI_E2B_DOMAIN`, `OPENGENI_E2B_API_URL` and `OPENGENI_E2B_SANDBOX_URL`, is passed to it explicitly on every create and resume instead of relying on ambient `E2B_*` variables. Before, the key was checked but never reached the SDK, and the SDK itself was missing. The connection is kept out of saved session state.
