---
"@opengeni/sdk": patch
---

The session relay answers `GET /v1/workspaces` with one read of the resolved workspace as the user (an empty list when they cannot read it), instead of listing all of their workspaces and filtering.
