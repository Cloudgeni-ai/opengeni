---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Opper is a first-class model provider with the same three rails as OpenRouter and Vercel AI Gateway. `OPENGENI_OPPER_API_KEY` adds reviewed EU-pinned `opper/vertexai/gemini-3.8-flash-eu` and `opper/aws/claude-sonnet-4-6-eu` routes billed in Opengeni credits (Opper list price +5%); workspace admins can connect their own Opper key (`workspace-opper/…`, billed to their Opper account) and add exact custom Opper ids; organization owners can connect Opper once for every shared workspace (`organization-opper/…`). The SDK adds `listWorkspaceOpperCustomModels`, `createWorkspaceOpperCustomModel`, `deleteWorkspaceOpperCustomModel`, `ModelConnectionAccessKind`, and `"opper"` as an organization model provider kind. Deployment catalog documents accept a reviewed `opperModels` list. Host `OPENGENI_MODEL_PROVIDERS_JSON` can no longer use the reserved `opper`, `workspace-opper`, or `organization-opper` provider ids; move a hand-written Opper registry entry to `OPENGENI_OPPER_API_KEY`. Rolling migration `0633_opper_model_providers.sql` widens the provider-kind, lifecycle-fact, and analytics allow-lists.
