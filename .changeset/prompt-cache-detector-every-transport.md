---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Prompt-cache diagnostics now fingerprint every provider transport, including the streamed request bodies of OpenAI, Azure OpenAI, Codex and xAI calls, which were never fingerprinted before. Two new warm-miss classes separate causes that `system_changed` and `unexplained` used to hide: `release_changed` (the tools or system prompt changed between two deployments) and `unobserved` (a call has no request fingerprint). The chart adds three alerts on the per-call classification: `OpenGeniPromptCachePrefixChanged`, `OpenGeniPromptCacheHistoryRewriteLossHigh` and `OpenGeniPromptCacheDiagnosticsBlind`.
