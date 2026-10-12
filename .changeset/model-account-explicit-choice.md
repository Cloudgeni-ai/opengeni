---
"@opengeni/db": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": patch
"@opengeni/api-router": patch
---

Add a provider-neutral explicit model-account choice for sessions and a person's own personal-fallback opt-in. `GET`/`PUT /v1/workspaces/{workspaceId}/sessions/{sessionId}/model-account` lists the workspace's shared accounts and the caller's own personal accounts with whether each can be chosen, and sets or clears an explicit choice; the database still decides, so a personal account is accepted only for its owner's private session or Personal workspace while personal accounts are allowed. An ownerless session lists every account as not choosable (`session_has_no_owner`). `GET`/`PATCH /v1/organizations/{organizationId}/me/model-account-preferences` reads and changes only the caller's own opt-in; turning it on wakes waiting turns so they can fall back at once. The SDK gains `getSessionModelAccount`, `setSessionModelAccount`, `getModelAccountPreferences` and `updateModelAccountPreferences`. Rolling migration 0729 adds the owner's own access to their preferences row and nothing else. `isCodexAccountEvent` in `@opengeni/react` also matches `model_account.selection.changed`.
