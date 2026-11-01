---
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

A member of a shared workspace (`connections:write`) now removes only the plugins, API integration accounts and integration sources they added themselves. Anything an admin, another person or no recorded installer added (every row from before members could add integrations included) is removed only by integration admins (`capabilities:manage`), who still remove anything; a member's other removal is refused with the usual `capabilities:manage` 403, decided inside the removal transaction. The installer is the existing `capability_plugin_installations.installed_by_subject_id` (an update hands it to whoever updated) and `integration_facet_bindings.created_by_subject_id` (adding a removed account or source back hands it to whoever adds it), so there is no migration. `GET …/plugins`, `GET …/integrations` and `GET …/integrations/:capabilityId/instances/:instanceKey/facets` now return `canRemove` for the caller on each plugin, account and configured source (always `false` on an API integration the organization serves here, which its settings manage), and the web app offers Remove from it, including on the plugin page for a member's own plugin when the organization keeps adding plugins for admins. New exports: `canRemoveIntegration` (core) and the `memberRemoval` option on `uninstallPluginPackage`, `uninstallApiIntegration` and `removeIntegrationFacet` (db).
