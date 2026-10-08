---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Operators can now see how long live sandboxes have gone without saving their workspace. The reaper publishes `opengeni_sandbox_checkpoint_staleness{kind="dirty"|"stale_4h"|"stale_12h"}` and `opengeni_sandbox_checkpoint_age_max_seconds` for live Modal sandboxes holding a write their last checkpoint did not capture, aged from the first such write (rolling migration 0672 adds the content-free inventory function). The new warning alert `OpenGeniSandboxCheckpointStale` fires when a sandbox has held unsaved changes for over 12 hours, half the default provider lifetime, and the sandbox dashboard gains panels for unsaved changes, the oldest unsaved change and skipped warm checkpoints.
