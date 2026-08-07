---
"@opengeni/config": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Add explicit provider-contained lazy-tool transports: preserve Codex native search, use native client tool search for direct OpenAI/Azure Responses, and use a cache-stable ordinary search/invoke dispatcher for other function-calling providers.