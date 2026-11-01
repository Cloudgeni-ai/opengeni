---
"@opengeni/api-router": patch
---

When GitHub refuses a person's saved personal GitHub grant, the personal repository endpoints (`/v1/workspaces/{id}/connections/{connectionId}/github/repositories` and its branch and selection routes) now answer `409` with "Reconnect your GitHub account to keep working as you" instead of `401`. A `401` means the person's Opengeni session ended, so the app showed "Your session ended. Sign in again" while the person was still signed in; it now tells them to reconnect GitHub.
