---
"@opengeni/config": minor
"@opengeni/api-router": minor
---

Add `OPENGENI_API_METRICS_PORT`. When it is set, the API serves `GET /metrics` only on that dedicated internal listener and never on the public API port, so an ingress that forwards every path to the API cannot publish Prometheus metrics. The listener applies the same deployment-key rules as before. Leaving it unset keeps the existing single-port behavior. The Helm chart now sets it by default (`api.metricsPort: 9464`). Upgrade note: on a cluster that enforces NetworkPolicy, only the bundled collector and `networkPolicy.monitoring` reach that port, so set `networkPolicy.monitoring` for any other Prometheus that scrapes the API. Managed-auth email verification now signs the user in on the first successful link click in the default `legacy` session-set mode, and every verification email tells a recipient who did not sign up to ignore it.
