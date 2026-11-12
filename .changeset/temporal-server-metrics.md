---
"@opengeni/deployment": patch
---

The chart's bundled Temporal now serves its own Prometheus metrics on `temporal.metrics.port` (default `9090`, port name `metrics` on the `<release>-temporal` Service). With `observability.serviceMonitor.enabled` a `<release>-temporal` ServiceMonitor scrapes it, and `networkPolicy.monitoring` admits the scraper on that port only. Frontend, history and matching `service_latency` and `persistence_latency` show whether a slow workflow start or signal is the Temporal server, its database, or the client side. `temporal.metrics.port: null` turns it off.
