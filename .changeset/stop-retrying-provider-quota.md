---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

An exhausted model-provider quota no longer retries. A daily or monthly allowance (for example OpenRouter's `free-models-per-day` cap or a requests/tokens-per-day limit), a used-up quota (`insufficient_quota`), an account out of credits (HTTP 402), or a 429 whose provider retry hint exceeds 15 minutes now fails the turn at once with the new `provider_quota_exhausted` code, `retryable: false`, a `quotaScope`, plain-language copy, and the provider's text as `detail`, instead of five paced same-turn recoveries. Ordinary per-minute rate limits, and quota wording whose provider retry hint is a minute or less, remain `provider_rate_limited` and retryable. `@opengeni/runtime` exports the classifier (`classifyProviderQuotaExhaustion`), and model clients that let the OpenAI SDK retry mark such a 429 `x-should-retry: false` so the SDK does not replay it either. Codex and SuperGrok subscription transports keep their credential-rotation and capacity-wait semantics.
