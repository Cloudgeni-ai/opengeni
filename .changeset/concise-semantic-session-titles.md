---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/events": minor
"@opengeni/react": minor
"@opengeni/runtime": minor
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Generate concise topic-oriented session titles with a prompt-free fallback, automatic-title safety normalization, custom-role and old-image rolling-compatible least-privilege database posture, and UI projections that never use raw initial prompts as display names. Durable title fanout now requires a versioned subscriber-recovery capability: managed NATS and supported embedded brokers coalesce one Postgres catch-up after reconnect, while legacy buses without that contract fail readiness/worker startup before durable rows can be acknowledged.