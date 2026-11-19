---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/react": minor
---

Console roles for organization members: an owner or admin gives a member Console Viewer (sessions at the review level, cost, agents read-only) or Editor (also creates, tests and publishes Console-managed agents), on Console's Members page or when inviting (`consoleRole`). Owners and admins stay full. `GET /v1/organizations/:id/console/access` returns the caller's level and `GET|PUT .../console/member-roles` lists and sets roles; role changes are audited (`member.console_role_changed`). A Console role never grants app workspace access. `RoleSelect` takes an optional `noAccessDescription`.
