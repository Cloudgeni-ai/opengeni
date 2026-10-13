---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
---

Leftover records no longer block making a chat Only me. The private visibility change now settles them in the same transaction: turns stuck `queued`, `recovering` or `waiting_capacity` on an idle chat are cancelled, RunState rows, questions and capacity waiters on finished turns are ignored, a finished background-command result carrying someone else's authority is cancelled, and schedules that can no longer run stop counting (rolling migration 0768). Work the person can see (a running or parked response, queued messages, an active goal) answers a typed `active_work` conflict unless `UpdateSessionVisibilityRequest.stopActiveWork` is sent; with it the change cancels that work, pauses the goal, interrupts a response a worker is executing and then completes, answering a retryable `stopping_active_work` with the same idempotency key if the worker is slow. New owner-only `GET /v1/workspaces/:workspaceId/sessions/:sessionId/visibility/preview?visibility=private` (SDK `previewSessionVisibilityChange`) reports that work and any block stopping it would not clear; the console shows one summary and one "Stop work and limit to me" confirmation. Blocks that protect another person's authority are unchanged.
