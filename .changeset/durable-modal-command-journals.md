---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
---

Retain Modal command handles, provider execution identities, output, and exact exit status across provider-client reconstruction. Persist stream pages before acknowledging their cursors, and treat unavailable historical locators as unknown rather than proof of process loss. Execution status is provider-owned and never read from sandbox-writable files.