---
"@opengeni/observability": patch
---

`opengeni_http_request_duration_seconds` has a 2-second bucket, so the core read latency alert's "p95 above 2 seconds" is exact. Before, the nearest bounds were 1 and 2.5 seconds, and the alert's p95 was interpolated inside that bucket: it paged when about a third of workspace and session reads took 1 to 2 seconds even when none took 2, and stayed quiet when a tenth took 2.2 seconds. Each HTTP route series gains one bucket series.
