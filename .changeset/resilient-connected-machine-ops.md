---
"@opengeni/runtime": patch
"@opengeni/config": patch
---

Make Connected Machine (selfhosted) control ops resilient: bounded retry of pre-admission DRAINING backpressure (any op) and of a single transient TIMEOUT (read-only idempotent ops only — a timed-out mutation is never re-issued), a separate long exec deadline distinct from the short control timeout (new `OPENGENI_SANDBOX_SELFHOSTED_EXEC_TIMEOUT_MS` / `OPENGENI_SANDBOX_SELFHOSTED_CONTROL_TIMEOUT_MS`, default 5min/30s), and actionable, human-language error copy for over-limit payloads, capacity backpressure, and exec-deadline termination.
