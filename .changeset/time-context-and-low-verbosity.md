---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Give the model the current time without a tool call, and ask supported models for shorter answers. Each claimed user message now carries a separate `[Message sent <weekday> <date> <HH:MM> UTC]` part taken from the turn's durable acceptance time, and each delivered machine-input batch states its `deliveredAt` and every member's `createdAt` (scheduled occurrences add `Delivered:` and `Created:` lines). The times are persisted with the history row, never computed at inference time, and never enter `Agent.instructions`. Agent turns on the Codex subscription and direct OpenAI Responses routes send `text.verbosity: "low"` for GPT-5-family and later models; the new optional `textVerbosity` agent option is omitted everywhere else, so Azure, Gateway, OpenRouter, SuperGrok, chat and other compatible routes are unchanged. `reasoning.summary` is unchanged.
