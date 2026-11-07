---
"@opengeni/worker-bundle": patch
---

The Helm chart's streaming p99 alerts (`OpenGeniEventAppendLatencyHigh`, `OpenGeniEventAppendLatencyCritical` and `OpenGeniEventPublishLatencyHigh`) now need at least 100 observations in their window before they can fire (`observability.prometheusRule.sessionEventMinSamples`, default 100), like the chart's other latency alerts. Below 100 observations a p99 is just the slowest single observation, so one or two slow writes on a quiet deployment could page as an outage. `OpenGeniModelProviderTtftRegression` is now suppressed only when the pre-dispatch latency condition holds with its own minimum request count, so a single slow pre-dispatch request no longer hides a provider regression. Promtool tests cover both.
