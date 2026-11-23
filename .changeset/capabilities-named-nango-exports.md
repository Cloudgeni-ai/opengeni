---
"@opengeni/capabilities": patch
---

Fix `@opengeni/core` and `@opengeni/api-router` failing to load from npm (6.36.0): `@opengeni/capabilities` now exports the shared Nango helpers such as `NANGO_TAG` by name. The publish check now fails when a built package imports a name that another package's build doesn't export.
