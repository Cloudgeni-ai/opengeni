---
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Deployment-funded live voice is credit-gated and billed per started minute. Heartbeats can return a `stop` instruction, the realtime controller ends the call gracefully and exposes `refusal` (`insufficient_credits`, `allowance_exhausted`, `monthly_model_cost_limit`, `realtime_voice_unavailable`), and catalog items carry `unavailableCode`. The voice control shows an out-of-credits state instead of a generic error.
