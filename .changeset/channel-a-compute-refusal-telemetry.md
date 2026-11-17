---
"@opengeni/api-router": patch
---

Channel-A failure telemetry now reports a compute admission refusal (the organization's running-box limit as 429 or 403, insufficient credits as 402) as a request rejection with the status the route returns, instead of an unexpected 500. An offline Connected Machine is reported as provider unavailable with the 409 the route returns. The `opengeni_channel_a_operation_failures_total` counter and its log line now agree with the HTTP response.
