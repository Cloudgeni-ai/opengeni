---
"@opengeni/api-router": patch
---

Channel-A failure telemetry now reports a compute admission refusal (the organization's running-box limit as 429 or 403, insufficient credits as 402) as a request rejection with the status the route returns, instead of an unexpected 500, so the `opengeni_channel_a_operation_failures_total` counter and its log line agree with the HTTP response for these refusals.
