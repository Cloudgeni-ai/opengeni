---
"@opengeni/contracts": patch
"@opengeni/capabilities": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/documents": patch
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
---

Integration Knowledge sync is retired. Integrations give agents tools and access; for recurring work, create an ordinary agent schedule that uses the integration's tools.

- Google Drive and OneDrive no longer offer a "Knowledge source" (`drive-content`) facet. Configuring a `knowledge_source` facet, or browsing or saving a source, returns 410.
- Creating a schedule with `agentConfig.knowledgeSource`, or changing a saved task's source, returns 410.
- Saved source tasks (a `knowledge_source_sync` action or `agentConfig.knowledgeSource`) for any provider now read as retired. Fires, manual runs and resume are refused, and queued runs fail with `knowledge_source_sync_retired`. Google Drive and Atlassian tasks keep their existing retirement reasons. You can still read and delete these tasks.
- The worker no longer contains the source sync workflow, its activities, or the `knowledge_source_fetch` and `knowledge_source_read` attempt tools.
- New in `@opengeni/contracts/knowledge-source-sync-retirement`: `retiredKnowledgeSourceSyncTask`, `isRetiredKnowledgeSourceSyncTask` and the shared retirement reasons. `isRetiredNativeGoogleDriveTask` and `isRetiredNativeAtlassianTask` are deprecated.
- Imported Documents, Knowledge entries, source provenance and run history stay readable. Public schemas and SDK types are unchanged, and no data or tables are removed.
