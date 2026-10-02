---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
---

The web client beacon (`POST /v1/client-errors`) now also admits closed, content-free operational signals discriminated by `signal`: key requests that failed before any HTTP response (`opengeni_client_request_failures_total{action,reason}`), live-stream health (`opengeni_client_stream_events_total{stream,event}`), and web vitals (`opengeni_client_web_vital{metric,page}` histogram). Error reports are unchanged.
