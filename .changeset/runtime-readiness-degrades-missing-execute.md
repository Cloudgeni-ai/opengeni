---
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

A missing runtime EXECUTE grant no longer takes the API and workers out of service. When the runtime role lacks EXECUTE on a routine the binary requires (a declared private routine or a target-schema capability), startup and readiness now report it as degraded and stay ready. It is reported through a structured warning, the `opengeni_runtime_database_degraded_findings` gauge and the new `OpenGeniRuntimeDatabaseGrantMissing` warning alert. Calls to the affected routines still fail with a permission error. A finding counts as degraded only when granting the missing EXECUTE removes it without raising any other finding.

Unsafe posture still fails startup and readiness:

- excess, PUBLIC or forbidden privileges
- wrong owners or search paths
- RLS problems
- forbidden role attributes or memberships
- missing CONNECT or schema USAGE
- missing or ambiguous objects
- anything that cannot be inspected

The posture CLI (the Helm migration job), the runtime-posture compatibility workflow and the previous-binary checks keep the strict evaluation, where every finding still fails.

Embedders: `runtimeDatabaseReadyCheck` and the worker's `databasePosture` readiness now also degrade on a missing required grant. Both take an optional listener for the degraded findings (`onDegraded`, and `onDegradedDatabasePosture` on `runOpenGeniWorker`). New exports from `@opengeni/db`:

- `classifyRuntimeDatabasePosture`, `assertRuntimeDatabaseReadiness` and `reportRuntimeDatabaseDegraded`
- the types `RuntimeDatabasePostureFindings`, `RuntimeDatabaseDegradedListener` and `RuntimeDatabaseDegradedObserver`
- the constants `RUNTIME_DATABASE_DEGRADED_GAUGE`, `RUNTIME_DATABASE_DEGRADED_LOG_INTERVAL_MS` and `RUNTIME_DATABASE_DEGRADED_LOG_FINDINGS`
