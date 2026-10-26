---
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
---

An image provider that is out of credit, rate limited, refusing or down no longer fails the turn as if the chat model were out of credits. `generate_image` returns its own short error and the turn continues, so the agent can tell the person and offer something else. Nothing is charged and held credits are released at once. Operators get the `opengeni_image_generation_provider_failures_total` metric and an `image generation provider failed` warning with the provider's detail; the agent and the person never see provider account text or billing links. Any other tool error that carries a provider 402 or 429 now stops the turn as `tool_provider_refused` instead of `provider_quota_exhausted` or a chat-model rate limit.
