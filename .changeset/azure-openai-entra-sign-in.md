---
"@opengeni/config": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/network": minor
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

An organization's Azure OpenAI connection can now sign in with Microsoft Entra ID instead of an API key, so Azure resources that turn key authentication off can run agent turns. Admins choose the sign-in method when connecting: an API key (unchanged), the organization's own Entra app registration with a client secret, or, when the operator sets `OPENGENI_AZURE_OPENAI_DEPLOYMENT_IDENTITY_ENABLED=true` and configures the standard `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_FEDERATED_TOKEN_FILE` or `AZURE_CLIENT_SECRET` variables, the deployment's own workload identity. Tokens for the `https://cognitiveservices.azure.com/.default` scope are cached per credential and renewed before they expire. The upsert request accepts `authentication` in place of `apiKey`, connection responses report `authMethod`, and the client config reports `azureOpenAIDeploymentIdentity`. `@opengeni/network/azure-entra` exports the shared token source.
