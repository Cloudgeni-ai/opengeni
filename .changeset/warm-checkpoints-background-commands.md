---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A running background command (a dev server, a long benchmark, a command whose output is still draining) no longer stops workspace checkpoints. Warm checkpoints taken during a turn were refused while a background command held the sandbox, potentially leaving later changes without a recovery point if the provider instance was lost. When the checkpoint is a Modal native snapshot (a point-in-time image of the paused box), it now runs around the exact active, unsupervised retained commands on the same box. A file a command was writing at that instant can be saved half-written; that is the accepted trade-off. Tar-style checkpoints still wait for commands. Such a checkpoint is recorded one generation behind the workspace, so it is never reported complete: periodic checkpoints continue, and a restore after provider loss shows the usual discontinuity warning. Rolling migration 0659 records the claim so a drain, a drain takeover or a late adoption can never publish it as the final workspace. Viewers, sibling turns, in-flight requests and supervised commands still block a checkpoint. The worker exports `opengeni_workspace_capture_skipped_total{backend,reason}` for warm checkpoint attempts that could not start.
