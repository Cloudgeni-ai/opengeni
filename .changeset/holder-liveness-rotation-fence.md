---
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Keep a live sandbox turn holder alive through a provider-deadline rotation: the resume-side holder-liveness loop releases only when the holder itself is gone or its attempt is superseded (`heartbeatLeaseHolderStatus` separates holder liveness from lease extension), the turn-side rotation checkpoint reinstates its exact lost holder at the same epoch/instance before the warm capture, mutation admission under a requested rotation reports `rotation_in_progress` instead of `lease_fenced` and starts that checkpoint, `write_stdin` to a retained PTY renders admission faults as the tool result instead of failing the turn, and `sandbox.box.terminated` carries the drain reason.
