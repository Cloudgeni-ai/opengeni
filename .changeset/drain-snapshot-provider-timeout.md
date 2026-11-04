---
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/deployment": patch
---

A chat computer whose workspace snapshot takes longer than the drain wait now finishes saving and shuts down, instead of retrying the same snapshot until Modal ends the box after 24 hours. The drain wait (`OPENGENI_SANDBOX_DRAIN_SNAPSHOT_TIMEOUT_MS`, or `OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS`) no longer doubles as Modal's own snapshot deadline: a drain gives the provider `OPENGENI_SANDBOX_DRAIN_PROVIDER_SNAPSHOT_TIMEOUT_MS` (default 10 minutes, never less than the wait), and a snapshot still running when the wait ends publishes late under its claim. After a snapshot fails, the next full attempt for the same box waits 30 seconds, doubling up to 10 minutes, except in the final save window before the provider deadline. Migration 1253 adds the per-lease failure count that drives this backoff.
