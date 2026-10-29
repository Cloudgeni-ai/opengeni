---
"@opengeni/decisions": patch
"@opengeni/config": patch
---

Decision models (tool-search selection and code search) can run on an Azure OpenAI resource that has key sign-in turned off. Set `OPENGENI_DECISION_MODEL_AUTH=deployment_identity` with provider `openai`, the deployment name and the resource's v1 base URL, and requests are signed with a cached Microsoft Entra token for the deployment's own identity. `createHttpDecisionModel` accepts an access-token function in place of a static key, and drops a token the provider rejects.
