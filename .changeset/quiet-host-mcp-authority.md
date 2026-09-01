---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Add explicit host authority provenance for opaque MCP connection references so embedding hosts can resolve any binding identity, including UUID values, without native delegation, catalog, attachment reauthorization, or reconnect flows reinterpreting it. Preserve the legacy non-UUID host-binding lane during rolling upgrades, retain host provenance after successful credential resolution, make auth-needed events inert in legacy browsers, and gate newly marked refs behind a default-off two-phase fleet activation.