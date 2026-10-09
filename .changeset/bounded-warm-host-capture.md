---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Stop a warm (periodic or turn-end) host-backed Local/Docker workspace capture at
`OPENGENI_SANDBOX_SNAPSHOT_TIMEOUT_MS` and release its exact capture claim once
the local reads have ended. A slow host no longer holds the workspace write
fence for the whole capture, which failed writes with
`SandboxWorkspaceMutationFencedError` and stalled turn finalization until the
worker was contained. A capture still queued behind provider operations is
abandoned the same way. Provider-native captures, archive publication and the
lease drain capture are unchanged.

The editable artifact materializer now retries an identity probe that timed out
at startup, with 1x, 3x and 9x the probe budget, instead of failing on one slow
start. Other probe failures are not retried.
