---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

A member of a shared workspace (`connections:write`) now removes the custom MCP servers they added themselves, with the new `DELETE /v1/workspaces/:workspaceId/capabilities/:capabilityId/installation` (SDK `removeCapabilityInstallation`). It removes the server's installation from the workspace; its catalog entry, connected accounts and any admin tool rules stay, and whoever adds it back becomes its installer. A server an admin or another person turned on, one with no recorded installer (every server from before this change) and one an admin turned off are removed only by integration admins (`capabilities:manage`), who remove any custom server; a member's other removal is refused with the usual `capabilities:manage` 403, decided on the locked row inside the removal transaction. The installer is recorded in the new `capability_installations.installed_by_subject_id` column (migration 1228, nullable, existing rows left empty). `GET …/capabilities` now returns `canRemove` for the caller on each catalog item, and the web app's connector page offers members "Remove from this workspace" from it; admins keep "Turn off for this workspace". Servers a plugin brings are removed with their plugin, a server the organization serves here is turned off here instead (`canRemove: false`, even once turned off), and servers configured in settings are not removable.
