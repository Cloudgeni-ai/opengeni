---
"@opengeni/sdk": minor
---

`memberPermissions` now also applies to tenant workspaces. When it is set, the
`Opengeni` facade and the session proxy add each signed-in user they resolve in
a tenant workspace with exactly those permissions before the user's first
request, using a stable onboarding key. Without it, Opengeni's first-use
defaults still apply. Anonymous visitors keep the defaults, and existing grants
are never changed.
