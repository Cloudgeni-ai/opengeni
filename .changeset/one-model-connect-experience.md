---
"@opengeni/react": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Connecting a model provider is now the same on the organization's Models page and on a workspace's: Connect provider lists the same providers in the same order (Codex, Claude subscription, SuperGrok, Azure OpenAI, OpenAI API, Anthropic API, OpenRouter, Vercel AI Gateway, Opper and Custom endpoint), each opening the same connect step. Only where the connection lives differs: organization owners and admins connect an organization account and choose its Available in; a shared workspace's admins connect Azure OpenAI, OpenAI and custom endpoints as that workspace's own keys from the same steps (they used to get a shorter list and a separate form lower on the page); anyone else sees API-key providers listed but disabled, with who can add them. The separate "OpenAI, Azure OpenAI and compatible endpoints" section is gone; a workspace's own keys are listed with its other accounts and disconnect from their row.

Azure OpenAI is one step: endpoint, deployment name and key, checked together with a short test message before anything is saved, so it ends with a working model. Pasting any address Azure shows for the resource (Cognitive Services or Foundry endpoint, or a deployment's Target URI) reads as its `https://RESOURCE.openai.azure.com` endpoint, and a Target URI fills in the deployment name. OpenAI asks for its first model the same way.

API: `PUT /v1/organizations/:id/model-providers/openai|azure_openai` accepts an optional `models` array (up to 16 model IDs or deployment names). Each is checked with the key (or Entra sign-in) in the request before saving, and they are saved with the connection in one transaction; other provider kinds refuse it with 422. Requests without `models` are unchanged.
