---
"@opengeni/api-router": patch
---

The phone and desktop apps can give a session full access. `PUT /v1/workspaces/:workspaceId/sessions/:sessionId/admin-access` required a same-origin browser request from every caller, so the apps, which sign in with their own bearer credential and send no browser origin, always got 403 and showed "Couldn't give full access". A bearer caller now skips the browser-origin check, as other bearer-friendly routes already do; a cookie session still has to be same-origin, and only the person themselves can give it.
