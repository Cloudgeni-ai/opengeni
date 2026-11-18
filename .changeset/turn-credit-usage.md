---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
---

Each turn reports the Opengeni credits it charged. `turn.completed`, `turn.failed`, `turn.cancelled` and `turn.superseded` carry `usage` (`{ creditsMicros, tokens: { input, output }, breakdown: { model, webSearch, imageGeneration, other } }`, USD micros) in the event payload, in the turn webhooks' `data`, and on each turn from the turns API (`TurnUsage` in `@opengeni/contracts` and `@opengeni/sdk`). It is computed from durable usage and ledger records when the terminal event is written (migrations 1493 and 1494), so it holds after worker recovery or a new attempt; `creditsMicros` is `null` when a charge has no known price, and turns from before this release return `usage: null`. Chat completions add OpenRouter's `usage.cost` (USD) to non-streamed responses and the final usage chunk. The session proxy, `sessionEventsToSseStream` and published Sites remove both from what browsers receive, and the Console shows each answer's cost beside the reply.
