---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/react": patch
---

Organizations and workspaces can choose the default voice model. Organization → Models → Voice and a workspace's Voice settings gain a "Default voice model" choice: the model a new voice conversation starts with. A workspace follows its organization's choice unless it picks its own, and "Automatic" keeps the previous behaviour (GPT Realtime when available, otherwise the first available model). People can still pick another model when they talk, and a model someone already picked on their device stays their choice while it remains available.

API: `OrganizationModelDefaults.realtimeDefaultModel` and `UpdateWorkspaceSettingsRequest.realtimeDefaultModel` (a voice model id, or null for automatic or to follow the organization), and the realtime model catalog marks `workspaceDefault` and `organizationDefault`. The packaged voice control starts with the person's own usable pick, then the workspace default, then the organization default. Rolling migration 0903 adds one nullable column.
