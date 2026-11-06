---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
---

OpenAI-compatible endpoint models can now reason at the levels they support. When a model is connected, Opengeni reads its levels and default from the endpoint's own `/models` listing (`supported_reasoning_efforts`, with the default in `default_reasoning_effort` or `reasoning_effort`), and an organization administrator can set or re-read them from each model's **Reasoning levels** button. The model picker then offers exactly those levels, and each request sends the chosen one as `reasoning_effort` (a level the model doesn't declare is sent as the nearest declared one below it); a model without levels gets no reasoning parameter, where before compatible requests carried whatever level the turn had, without any way to choose it. The reasoning text and cached input tokens these endpoints return are read back as on other Chat Completions routes. Organization endpoint models carry `reasoning` (`OrganizationCompatibleEndpointModel`); connecting an endpoint or adding a model accepts an optional `reasoning`; a new `PUT …/endpoints/:connectionId/models/:customModelId/reasoning` route and the SDK's `setOrganizationCompatibleEndpointModelReasoning` change them; and a workspace compatible connection's `directModelProvider` accepts an optional `reasoning`.
