---
"@opengeni/worker-bundle": patch
---

Track turn-progress gauges per physical attempt and always clear them when the activity finalizes, preventing recoverable replacements from leaving false stuck-turn alerts.