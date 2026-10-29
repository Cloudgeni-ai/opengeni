---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
---

Members of a shared workspace can now rename it and add or remove its custom model entries. `PATCH /v1/workspaces/:workspaceId` checks each field: anyone who can start chats there (`sessions:create`, acting as themselves) may change `name` on a shared workspace and `agentInstructions`, while `slug` still needs `workspace:admin` and a Personal workspace keeps its name. The Gateway, OpenRouter, Opper and Claude custom model routes (`/gateway-custom-models`, `/openrouter-custom-models`, `/opper-custom-models`, `/model-providers/:providerKind/custom-models`) take the same rule; the keys and subscriptions those models run on, and which models a key may serve, stay with admins. Agents' own tokens, organization and workspace API keys without `workspace:admin`, services and viewers are still refused; a member's personal API key acts as that member. The app action catalog lists these actions under `sessions:create`. In the web app, Rename and the custom model controls show for these members, and the organization Models list opens such a workspace for its custom models.
