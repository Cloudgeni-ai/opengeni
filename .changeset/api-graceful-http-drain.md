---
"@opengeni/api-router": patch
"@opengeni/config": patch
---

The API now drains its HTTP connections on shutdown instead of resetting them. A client that reused a pooled keep-alive connection while the pod was stopping could get ECONNRESET for a request the server had completed. From SIGTERM the API stops listening, closes idle keep-alive connections, marks every later response `Connection: close`, ends live event streams and closes WebSockets with 1001 so their clients resume elsewhere, and lets in-flight requests finish before closing its database, NATS and Temporal clients. New setting `OPENGENI_API_SHUTDOWN_GRACE_MS` (default 30000) is the time the process has after SIGTERM; the Helm chart renders it as the API pod's termination grace less its preStop drain, and requests still running 10 seconds before it ends are closed.
