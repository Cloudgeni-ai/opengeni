---
"@opengeni/worker-bundle": patch
---

A model call that reported no token usage at all (for example a Responses terminal event without a usage object, which the SDK turns into all-zero counts) is now counted as `opengeni_model_cache_read_telemetry_total{status="no_usage"}` instead of `status="missing"`; `missing` is kept for calls that reported usage but left out the cached-token field. `OpenGeniCodexPromptCacheTelemetryMissing` now needs at least 3 missing calls and over 5% of the calls that reported usage in 30 minutes, so one call can no longer page, and its absent-usage clause ignores no-usage calls.
