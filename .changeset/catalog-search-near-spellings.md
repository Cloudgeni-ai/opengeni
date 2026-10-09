---
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Agent capability catalog search now tolerates near spellings, so "Wispr" or "Wisprflow" finds a custom MCP named "Whisprflow". Typo-only hits rank below exact, prefix and substring hits and carry `approximate: true`. Custom catalog entries without a provider domain are also matched by their endpoint's registrable domain (for example `api.wisprflow.ai` matches `wisprflow.ai`). When nothing matches, `capability_catalog_search` returns the closest catalog names as labelled `suggestions` instead of a bare empty result, so the agent does not conclude an existing integration is missing.
