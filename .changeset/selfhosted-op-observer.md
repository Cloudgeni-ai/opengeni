---
"@opengeni/runtime": patch
---

Add a transport-agnostic per-op observation seam (`SelfhostedOpObserver`) to the Connected Machine control path, plus a metrics sink. `SelfhostedSession.call` invokes an optional injected observer once per completed op with op-shaped telemetry (op kind, ok/failed outcome, healed-after-retry flag, retry count, typed code/reason, never-sent, duration, and reply bytes on a payload-wall fault). The observer is guarded so a telemetry sink can never break an op, and it is threaded through the sandbox client/build + routing resolver so the worker can wire it. `RuntimeMetricsHooks` gains `onSandboxOp` for the op-outcome counters/histograms. The op-engine's future op-stream client emits through the same observer interface.
