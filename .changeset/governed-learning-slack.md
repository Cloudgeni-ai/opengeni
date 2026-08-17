---
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": patch
---

Publish governed-learning activations and undos to the configured workspace Slack channel through the existing durable publication outbox. The dead durable-learning adapter (`publishDurableLearningOutcomeToSlack`) is replaced by `publishGovernedLearningEventToSlack`, which projects only content-free receipt facts, uses `governed-learning:<event>:<receiptId>` idempotency, and fails closed for Slack-derived evidence.
