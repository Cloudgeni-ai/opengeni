---
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/contracts": patch
"@opengeni/worker-bundle": patch
---

Models a deployment lists under the same name now say what differs, so a person
never sees two choices they can't tell apart. When two routes of a model share a
name in the same picker group, a route whose residency record names its
processing geography gets it in brackets ("GPT-6.1 Sol" and "GPT-6.1 Sol (EU)");
twins in the same place get their connection's name instead ("Sonnet 4.6 (Your
OpenRouter)"). Models with a unique name, and organization and workspace copies
of one model, keep their plain name. The picker search, the trigger and the
Models settings view use the same names, and `list_models` shows the agent the
same name for such twins. The SDK's `ClientModel` type now includes the
`residency` record the server already sends; `@opengeni/sdk/model-picker-order`
exports `modelLabelDistinctions` and `@opengeni/react/model-policy` exports
`withDistinctLabels` for hosts that build their own picker rows. EU
status still comes only from residency records, never a name.
