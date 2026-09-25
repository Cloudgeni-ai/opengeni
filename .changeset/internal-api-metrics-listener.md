---
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Add `OPENGENI_API_METRICS_PORT`. When it is set, the API serves `GET /metrics` only on that dedicated internal listener and never on the public API port, so an ingress that forwards every path to the API cannot publish Prometheus metrics. The listener applies the same deployment-key rules as before. Leaving it unset keeps the existing single-port behavior. Managed-auth email verification now signs the user in on the first successful link click in the default `legacy` session-set mode.
