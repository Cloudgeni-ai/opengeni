---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agent turns spend less time before each model request. The checks run before every model request (task usage limit, funding, workspace allowance and monthly limits) now read in parallel and still report the same refusal as before. Packaged Skills and interaction tool schemas are prepared once per process instead of on every turn.

New latency metrics: `opengeni_model_response_to_next_dispatch_seconds` (the gap from one model response to the next request, by phase) and the parts of response metering (`response_usage_lease`, `_billing`, `_cache`, `_checkpoint` on `opengeni_model_step_phase_duration_seconds`). A small sample of agent turns also exports its database statement spans when OTLP tracing is configured.
