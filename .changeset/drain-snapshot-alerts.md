---
"@opengeni/worker-bundle": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/react": patch
---

Drain snapshot failures are now visible. The worker records each settled drain snapshot failure with the lease's consecutive failure count (`opengeni_sandbox_drain_capture_failures_total`, `opengeni_sandbox_drain_capture_consecutive_failures`) and the `/workspace` file count and bytes when a drain snapshot settles (`opengeni_sandbox_workspace_snapshot_files`, `opengeni_sandbox_workspace_snapshot_bytes`; from the archive itself, or one bounded walk after a failed provider snapshot). New alerts fire when one lease's drain snapshot fails a fourth time in a row (`OpenGeniSandboxDrainSnapshotFailing`) and when a sandbox has been stuck draining for over an hour (`OpenGeniSandboxDrainExpiredLong`, critical). When a lost sandbox is restored from an older verified save, every chat sharing it now shows a notice with the save's time; the model's existing discontinuity instruction is unchanged.
