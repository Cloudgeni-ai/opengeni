---
"@opengeni/worker-bundle": patch
---

Treat transient upstream model-provider failures as retryable so a goal-bearing session recovers automatically instead of going terminal. A provider 5xx (500/502/503/529), a generic "server had a bad minute" body, or a dropped/again-able network connection (ECONNRESET/ETIMEDOUT/EAI_AGAIN/…) now classifies `retryable` and routes into the existing idle + goal-continuation path (auto-continue after the backpressure delay for goal-bearing sessions; wait for the next user message otherwise). Previously only 429/rate-limit and MCP-timeout were retryable, so a generic provider 5xx fell through to a hard `session.failed` that required a manual nudge — during an upstream provider degradation window this needlessly hard-failed a fleet of live sessions. HTTP status is authoritative (every 5xx retryable, 4xx still hard-fails); the ChatGPT/Codex usage-cap 429 stays non-retryable since a retry would just re-hit the cap.
