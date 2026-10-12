---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Workspaces can turn off Opengeni-credit models in one step. The workspace setting `allowCreditModels: false` (`PATCH /v1/workspaces/:id/settings`, SDK `updateWorkspaceSettings`) blocks every model billed in Opengeni credits, including credit models added to the catalog later. The allowlist stays as it is, whether the workspace has its own or follows its organization's. Session creation, messages, schedules, goals, child agents and the omitted-model default all honor it, and so do credit-funded live voice and voice input (where credits are billed; voice input falls back to a connected subscription) and managed video generation. Paid web search and knowledge embeddings are not affected. The model-policy responses report it as `allowCreditModels`; saving or removing an allowlist never changes it. The React live-voice control labels a model refused for this reason "Credits off".
