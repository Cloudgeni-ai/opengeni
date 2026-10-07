---
"@opengeni/react": patch
"@opengeni/worker-bundle": patch
---

When a model provider is overloaded or unavailable, conversations now name the affected model and provider instead of reporting a generic "upstream dependency". While Opengeni retries the same turn, a live status above the composer reads, for example, "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock) — retrying (attempt 2 of 5)…". It replaces itself on each attempt and adds no timeline rows. If every retry fails, the turn ends with "Claude Opus 5.5 is overloaded at the provider (Amazon Bedrock). Opengeni retried 5 times without success. Try again in a few minutes, or switch to another model." The web app's failure banner keeps its Retry button and suggests the model picker. Recovery events gain the optional public fields `modelLabel`, `providerLabel`, `providerCondition` and `maxProviderRecoveryCount`. `@opengeni/react` exports `ProviderRecoveryNotice` and `currentProviderRecovery`, and `SessionConversation` shows the live status automatically. Retry pacing and the five-retry budget are unchanged.
