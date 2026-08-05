<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Shared observability distribution core

Status: accepted design
Owner: OpenGeni infrastructure
Date: 2026-08-05

## Decision

OpenGeni will ship one public Kubernetes observability distribution that both
self-hosted and managed installations can consume with environment overlays.

The existing `deploy/observability` dashboard directory becomes the root of a
separate Helm wrapper around an exactly pinned upstream
`kube-prometheus-stack`. The wrapper lifecycle-manages Prometheus,
Prometheus Operator, Alertmanager, Grafana, cluster exporters, persistence and
resource defaults, and canonical dashboard ConfigMaps. Dashboard ConfigMaps are
rendered directly from the JSON files already in that directory; generated or
environment-owned copies are not authoritative.

The OpenGeni application chart remains separate. It owns application metrics,
`ServiceMonitor`, `PrometheusRule`, and OTLP integration, but it does not acquire
the observability platform as a chart dependency. The stack plan installs the
wrapper first so its CRDs exist. The next ordinary application release then
enables the integration resources with a shared discovery label using its exact
application chart and authoritative values. Observability-only install or
destroy actions never reconcile application workloads or execute application
hooks. Prometheus discovery is limited to namespaces carrying that label.
Grafana's dashboard sidecar reads ConfigMaps only from the wrapper namespace and
receives no cluster-wide Secret access.

Environment overlays may add or replace only deployment-specific concerns:

- ingress, TLS, and authentication;
- Grafana administrator credential delivery;
- Alertmanager receivers and routing;
- remote write, long-term storage, and provider integrations;
- storage classes, scheduling, topology, replicas, and capacity;
- additive environment-only dashboards, probes, and rules.

They must not fork the canonical OpenGeni dashboard JSON or replace the public
application rule catalog.

## Rationale

Keeping the monitoring backend only in deployment-specific automation creates
two operational products: one with a mature backend and one where self-hosters
must assemble Prometheus, Grafana, selectors, dashboards, storage, and
verification independently. That separation also makes it easy for the managed
installation to drift from the public dashboards and application rules.

Making the application chart depend directly on `kube-prometheus-stack` would
solve distribution at the wrong boundary. It would make every OpenGeni chart
upgrade own cluster-scoped CRDs and a large platform lifecycle, conflict with
clusters that already have monitoring, and couple application rollback to
Prometheus and Grafana data.

The separate wrapper preserves those lifecycles while giving both installation
types the same versioned core. Turning the existing dashboard directory into the
chart root also allows Helm `.Files` to package the exact source files, avoiding
a second generated or copied dashboard tree.

## Defaults and profiles

The base profile is persistent, single-replica, and sized for a compact
self-hosted cluster. It uses bounded retention and explicit requests/limits so
installation cost is visible. A larger example profile increases storage,
retention, and resources and switches Grafana to an existing administrator
Secret. Neither profile claims high availability; production operators must
review failure domains, backups, reclaim policy, and capacity.

The wrapper is optional. A cluster with an existing compatible Prometheus
Operator and Grafana sidecar can disable the bundled dependency and consume the
canonical dashboard ConfigMaps plus the shared application labels. Installing a
second operator without an explicit CRD ownership plan is unsupported.

## Verification contract

An installed Helm release alone is insufficient evidence. The public verifier
must prove:

1. the expected wrapper chart version is deployed;
2. every canonical dashboard ConfigMap exactly matches its source bytes, hash,
   and source revision;
3. OpenGeni `ServiceMonitor` and `PrometheusRule` objects exist with the shared
   selector label;
4. required recording and alerting rules are present in the objects and loaded
   healthily by the live Prometheus rules API;
5. every OpenGeni `ServiceMonitor` has discovered, healthy live targets;
6. Grafana is healthy and its dashboard sidecar has materialized the exact
   canonical files.

Object-only verification is useful for diagnosis but is not a successful live
receipt, because it cannot prove backend consumption.

## Upgrade and rollback

The wrapper dependency version, dependency lock, rendered manifest review, and
live receipt are one upgrade unit. Version ranges and mutable chart lookups are
not allowed in release automation.

Application telemetry changes remain independently releasable when they are
backward-compatible with the installed rules. A rule or dashboard that requires
a new metric must not be deployed before the emitter. Rollback should pair a
compatible application release with its compatible observability bundle.

Uninstall is potentially data-destructive. Operators must export Grafana state,
snapshot required metrics data, and verify PVC and underlying volume reclaim
behavior before removing the wrapper release or namespace.
