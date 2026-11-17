---
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
---

Operators can now see turns parked waiting for subscription capacity. A turn that finds no account with capacity (a usage limit or no eligible account) parks as its chat's active turn, so `opengeni_turns_queued_by_hold{hold="waiting_capacity"}`, which counts only prompts queued behind it, read 0 while turns waited for hours. The control worker now publishes `opengeni_turns_waiting_capacity{provider}`, the number of turns parked right now by the provider they wait on (`codex`, `claude`, `xai`; 0 when none), and `opengeni_turns_waiting_capacity_oldest_age_seconds{provider}`, the seconds since the oldest of them parked. The worker logs `Turn started waiting for subscription capacity` when a turn parks and `Turn stopped waiting for subscription capacity` (with `outcome`, `reason` and `waitedSeconds`) when capacity returns or the wait is superseded.

Migration 1485 adds the content-free `opengeni_private.summarize_capacity_waiting_turns_v1()` with its runtime grant withheld for one release, so the gauges appear once a later migration grants it. `@opengeni/db` exports `summarizeCapacityWaitingTurns`, `capacityWaitingTurnsSummaryAvailable` and `CAPACITY_WAITING_TURN_PROVIDERS`, and a resumed or superseded capacity reconcile reports when the turn parked.
