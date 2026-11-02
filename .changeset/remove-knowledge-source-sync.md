---
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
"@opengeni/capabilities": minor
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/documents": minor
"@opengeni/react": minor
"@opengeni/sdk": minor
---

Integration Knowledge sync is fully removed. A migration deletes the leftover Knowledge source sync tasks with their runs, sync state and wakes, and any saved `knowledge_source` facets; Automations no longer show "Sync retired" and the integration facets panel no longer shows "Retired" sources. Native Google Drive and Atlassian source connections left from the old sync stay hidden and inert; the generic connection DELETE still revokes them. Schedules only run agent turns. The native Google Drive and Atlassian source OAuth, callbacks, lifecycle and source routes are gone; Google Drive, OneDrive and Atlassian keep working through their agent-tool connections.

- Removed internal entry points: `@opengeni/documents/google-drive`, `@opengeni/documents/atlassian` and `@opengeni/contracts/google-drive-native-retirement`. `@opengeni/contracts/knowledge-source-sync-retirement` now exports only `KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE`, and `@opengeni/contracts/atlassian-native-retirement` only the historical tool names.
- Removed internal `@opengeni/contracts` root exports: `KnowledgeSourceSyncScheduleControl`, `scheduledTaskKnowledgeSource`, `requireScheduledTaskKnowledgeSource` and `knowledgeSourceAgentConfig`.
- The `OPENGENI_GOOGLE_DRIVE_CLIENT_ID`, `OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET`, `OPENGENI_GOOGLE_DRIVE_SYNC_*`, `OPENGENI_GOOGLE_DRIVE_PROVIDER_*`, `OPENGENI_ATLASSIAN_CLIENT_ID` and `OPENGENI_ATLASSIAN_CLIENT_SECRET` settings are no longer read.
- Public SDK surface is unchanged until the next major: `browseAtlassianSources`, `saveAtlassianSources`, `setAtlassianLifecycle`, `transitionGoogleDriveLifecycle`, `browseGoogleDriveFacetSource`, `saveGoogleDriveFacetSource`, `disconnectGoogleDriveConnection`, `CreateKnowledgeSourceSyncScheduledTaskRequest`, `agentConfig.knowledgeSource` and `KnowledgeSourceSyncRunSummary` are deprecated. Their routes answer 410, except `disconnectGoogleDriveConnection`, which now revokes through the generic connection DELETE.
