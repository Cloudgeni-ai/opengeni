---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
"@opengeni/core": patch
---

Fix large Connected Machine writes for machine-addressed operations, including run_on. Negotiate epoch-zero transactional upload support without inventing session epochs or replaying mutations. Older transactional agents receive a preflight 256 KiB limit and update guidance; nonzero session transfers remain compatible. Large machine-addressed transfers require the corresponding native agent release.
