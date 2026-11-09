---
"@opengeni/worker-bundle": patch
---

Turn startup latency alerts no longer fire when messages simply wait behind a turn still running in the same chat. The worker now also records `opengeni_turn_startup_since_attempt_start_seconds` for the provider-dispatch and first-byte milestones, measured from the start of the turn attempt that reached them, so it leaves out time behind an earlier turn, subscription capacity waits and recovery gaps. The provider-dispatch and first-byte p95 alerts use it, and the cumulative queue p95 alert is replaced by `OpenGeniTurnReadyPromptWaiting` (warning above 60 seconds) and `OpenGeniTurnReadyPromptWaitingCritical` (page above 300 seconds), which watch the oldest prompt nothing in its session holds back. The Helm value `observability.prometheusRule.turnStartupQueueP95Seconds` is replaced by `turnReadyPromptAgeSeconds` and `turnReadyPromptAgeCriticalSeconds`. The cumulative milestone histogram is unchanged and stays on the Turn Startup dashboard.
