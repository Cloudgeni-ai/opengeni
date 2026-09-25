---
"@opengeni/api-router": patch
"@opengeni/observability": patch
---

Add a public, content-free `POST /v1/client-errors` beacon that counts web
client failures in `opengeni_client_errors_total{kind}` with per-kind admission
bounds, and admit its grammar-validated route pattern and bundle revision in
public structured logs.
