---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Writing a turn's terminal event no longer re-reads every model call of the turn to attach its `usage`. Running per-turn credit totals (`session_turn_credit_totals`, `session_turn_credit_calls`), kept exact by triggers on `session_events` and `usage_events`, hold what the previous full sum computed, and the terminal trigger reads them; a turn whose totals are not ready (it predates the migration, has a refund row, or had a counted row updated) still gets the previous full sum, so `usage` is unchanged. The migration installs the triggers without reading history and an online batched backfill completes one turn per transaction. The runtime role can read but not write the totals, a TRUNCATE of either source clears them, and the worker samples turns each metrics cycle and reports any that differ from a full recount (`opengeni_session_turn_credit_totals_mismatched_turns`).

Readiness probes no longer fingerprint the database catalogs every 10 seconds: a passing runtime posture inspection stands for 60 seconds per process, with only a connectivity check in between, and any failed probe inspects in full again until one passes.
