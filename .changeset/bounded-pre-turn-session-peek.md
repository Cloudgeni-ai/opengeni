---
"@opengeni/worker-bundle": patch
"@opengeni/db": patch
---

A queued turn no longer waits two minutes when the session's pre-turn peek attempt is lost. Every session run peeks at durable session state on the control queue before it dispatches a turn; that activity used the general two-minute control timeout, so a lost or stuck attempt was retried only after two minutes while the turn queue showed no backlog. The peek now has its own 15-second attempt bound with the same unbounded retry.

Migration 1274 grants the runtime role EXECUTE on the queued-turn hold summary that 0988 withheld, and readiness now requires it. The control worker therefore publishes `opengeni_turns_queued_by_hold{hold}` and `opengeni_turns_queued_oldest_age_seconds{hold}`; the `ready` class shows prompts waiting for dispatch wherever they wait, including before a turn-queue task exists. The startup-queue alert, launch runbook and worker-fleet dashboard now point at it next to the eligible turn backlog. The turn-slot gauge help explains that an idle worker's reserved slots are its open polls, which take turns as they arrive.
