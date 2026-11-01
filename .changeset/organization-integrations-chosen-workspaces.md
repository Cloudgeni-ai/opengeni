---
"@opengeni/db": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": minor
---

An organization's credential provider and webhooks can work in chosen shared workspaces only (`allowedWorkspaceIds`), on top of the workspace filter. Existing ones keep working in every shared workspace; a provider PUT or webhook PATCH that leaves the list out keeps it.
