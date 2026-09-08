---
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Add per-connection turn-model permissions and organization workspace assignment
for subscriptions and model gateways. Migration 0424 requires draining APIs and
workers; do not restart older workers after policies are enabled.

Fix organization Codex sign-in in local mode without granting managed-human reset-credit ownership to the local administrator.
