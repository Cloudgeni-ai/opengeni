---
"@opengeni/codex": patch
---

Classify streaming response completion after parsing the final SSE block, so successful responses without a trailing blank separator do not produce false failed-request telemetry. Preserve genuine missing-terminal and provider failures and exactly one terminal audit event per attempt.