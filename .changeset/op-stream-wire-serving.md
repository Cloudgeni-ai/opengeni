---
"@opengeni/agent-proto": minor
---

Op-stream wire additions (all additive; PROTOCOL v1.1): `OpExit.failure_code`
+ `failure_detail` (typed runner-decided deaths — OP_OVERFLOW / OP_SPOOL_IO /
OP_PIPE_IO — never exit-code sentinels), `OpAttach.window_bytes` (0 = reuse
the OpStart grant), and heartbeat capacity telemetry
(`Heartbeat.capacity`/`.admission`: HostCapacitySample + AdmissionTelemetry
incl. live_ops, op_frames_dropped_total, evicted_unacked_total — the upward
report the server paces against). The runner now serves the op-stream
protocol and advertises `Capabilities.op_stream = true`; the server-side
feature flag still gates use (no flag day).
