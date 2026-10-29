---
"@opengeni/documents": patch
"@opengeni/config": patch
---

Knowledge embeddings can run on an Azure OpenAI resource that has key sign-in turned off. Set `OPENGENI_DOCUMENT_EMBEDDING_AUTH=deployment_identity` with the resource's v1 base URL in `OPENGENI_DOCUMENT_EMBEDDING_BASE_URL` and the embedding deployment's name as the model, and requests are signed with a cached Microsoft Entra token for the deployment's own identity. A rejected token is dropped so the next request signs in again. Without a usable identity or base URL, embeddings report themselves unavailable and no other key is tried. `OpenAIEmbeddingProvider` and `OpenAICurationProvider` accept an access-token function in place of a static key.
