---
"@opengeni/worker-bundle": patch
"@opengeni/api-router": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/testing": patch
---

An idle deployment no longer starts a Temporal workflow on every tick of the session wake dispatcher (every 10 seconds), Knowledge indexing (every 15 seconds) and site-auth maintenance (every minute). The control worker now runs these cadences itself: each tick is one cheap read-only check of whether the job's claim could find work, and the workflow starts only when it could. Periods and claims are unchanged, and a failed check still starts the workflow. The old per-tick Temporal Schedules are deleted at startup; an older release recreates them, so rollback keeps working. Immediate wake requests now signal-with-start one fixed dispatcher execution, and a request that arrives during a sweep runs exactly one more sweep. New migration 0730 adds the read-only checks with the same owner and grants as the claims they preview. New metrics: `opengeni_maintenance_cadence_ticks_total{job,outcome}` and `opengeni_maintenance_cadence_last_success_timestamp_seconds{job}`. `registerKnowledgeIndexingSchedule`, `registerSiteAuthMaintenanceSchedule` and `registerSessionWorkflowWakeDispatcherSchedule` are replaced by `startInternalMaintenanceCadences`.
