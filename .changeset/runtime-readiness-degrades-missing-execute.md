---
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

A missing runtime EXECUTE grant no longer takes the API and workers out of service. When the runtime role lacks EXECUTE on a routine the binary requires (a declared private routine or a target-schema capability), startup and readiness now report it as degraded, through a structured warning and the `opengeni_runtime_database_degraded_findings` gauge, and stay ready: only the feature behind that routine fails. Unsafe posture still fails startup and readiness: excess, PUBLIC or forbidden privileges, wrong owners or search paths, RLS problems, forbidden role attributes or memberships, missing CONNECT or schema USAGE, missing or ambiguous objects, and anything that cannot be inspected. A finding counts as degraded only when granting the missing EXECUTE removes it without raising any other finding. The posture CLI, the runtime-posture compatibility workflow and previous-binary checks keep the strict evaluation, where every finding still fails. New exports: `classifyRuntimeDatabasePosture`, `assertRuntimeDatabaseReadiness` and `reportRuntimeDatabaseDegraded`.
