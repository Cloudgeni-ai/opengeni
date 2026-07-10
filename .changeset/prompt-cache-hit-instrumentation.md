---
"@opengeni/worker-bundle": patch
---

Make prompt-cache efficiency measurable per model call. The worker now reads `cached_tokens` from the same usage frame that feeds input-token accounting and emits two provider-labelled Prometheus series: `opengeni_model_cached_tokens_total{provider}` (cumulative prompt tokens served from the provider's cache) and `opengeni_model_cache_hit_ratio{provider}` (per-call cached/prompt ratio, bucketed around the alerting threshold). A provider that does not report cached tokens records a real 0 ratio rather than nothing — "the cache did nothing" is the signal — and never a phantom counter increment. Labels stay bounded (provider only; never a session id or account).

Each per-call `model call usage` log line gains two log-only research dimensions: `servingAccountHash` (an opaque, non-reversible tag for the serving codex credential — the credential row id hashed, never a token) and `accountChangedFromPrevCall` (whether the serving account changed versus the session's previous call — the account-rotation-cold-starts-the-cache hypothesis). These are log-only and never leak into the durable `agent.model.usage` event, which already carries `cachedTokens`. The non-codex credit-debit ledger record additionally carries `cachedTokens` (additive).

A new starter alert `OpenGeniCodexPromptCacheHitRatioLow` fires when the codex-subscription cache-hit ratio p50 falls below 40% over 30m while codex calls are flowing (traffic-gated with the `or vector(0)` empty-vector guard, promtool-validated).
