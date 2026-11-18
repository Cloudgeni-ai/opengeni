---
"@opengeni/config": minor
"@opengeni/runtime": minor
---

Decision models can run on Azure AI Foundry (for example Microsoft-Decision-1.1). `OPENGENI_DECISION_MODEL_ENDPOINT` (and `OPENGENI_PUBLIC_DECISION_MODEL_ENDPOINT`) sets the exact URL an `openai` or `openrouter` decision model posts to, `OPENGENI_DECISION_MODEL_AUTH=deployment_identity` now works for `openrouter` as well as `openai`, and an `openrouter` decision model at the operator's own endpoint can be declared EU in `OPENGENI_SIDE_FEATURE_RESIDENCY_JSON` under `decision_model.openrouter` (OpenRouter's own host keeps its global rule). `OPENGENI_TOOL_SEARCH_LOAD_THRESHOLD` sets the probability above which tool search loads a judged tool; unset keeps 0.5. `selectFromJudgments` takes an optional threshold, `createToolSelector` an optional `loadThreshold`, and `BuildAgentOptions` an optional `toolSearchLoadThreshold`.
