---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Recover a turn when a managed sandbox command fails to start before dispatch
inside an `exec_command` call. On every subscription-core route, checkpoint the
answered model request first so the turn recovers with the existing
connectivity backoff and limits instead of failing. The provable call is
settled as not started (replay safe) rather than outcome unknown. Recoveries
that interrupt a running tool now count toward the same budget until the turn
makes tool progress, so they cannot loop without bound.

A retryable failure that cannot recover automatically now says so instead of
promising a retry. When recovery is exhausted, Retry stays available. Retry
refusals now separate work that is still settling (`RETRY_EXECUTION_UNRESOLVED`)
from a permanent unknown tool outcome (`RETRY_TOOL_OUTCOME_UNKNOWN`), and the
web app tells the person what to do in each case. No migration or configuration
change is required.
