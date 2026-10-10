---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Workspaces can turn off Opengeni-credit models in one step. The workspace setting `allowCreditModels: false` (`PATCH /v1/workspaces/:id/settings`, SDK `updateWorkspaceSettings`) blocks every model billed in Opengeni credits, including credit models added to the catalog later, without turning the allowlist into an exact list and whichever allowlist the workspace follows. Session creation, messages, schedules, goals, child agents and the omitted-model default all honor it, and so do credit-funded live voice and voice input (where credits are billed) and managed video generation. Paid web search and knowledge embeddings are not affected. The model-policy responses report it as `allowCreditModels`; saving or removing an allowlist never changes it.
