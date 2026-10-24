---
"@opengeni/observability": minor
"@opengeni/db": patch
"@opengeni/config": minor
---

API request traces can now be followed across service boundaries and show where a request spends its time. A request's W3C `traceparent` header is no longer ignored: by default the request span keeps its own trace and links to the caller's span, and a deployment whose callers are all trusted can set `OPENGENI_OBSERVABILITY_TRUST_INCOMING_TRACE_CONTEXT=true` to make the request span a child in the caller's trace. Request spans are now SERVER spans with child spans for each database statement and transaction, each outbound HTTP call, and each object storage and workflow client call, within a budget of 256 per request. Span attributes carry only the statement's operation and table or routine name, row counts, SQLSTATE codes, HTTP methods and statuses: never SQL text, parameters, URLs or messages. Telemetry export no longer runs inside the trace it exports. New observability exports: `startChildSpan`, `childSpanRecordingActive`, `withoutTraceContext`, `traceFetch` and `traceClientCalls`, plus `kind` and `childSpanLimit` options on `startSpan`.
