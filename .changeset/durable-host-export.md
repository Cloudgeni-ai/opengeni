---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/core": minor
"@opengeni/worker-bundle": minor
---

Add an optional durable host event and usage export for embedded deployments: source-transactional bounded snapshots, immutable turn attribution, named at-least-once checkpoints, multi-replica leases, replay and retention controls, explicit poison-record disposition, an isolated exporter database role, and a worker delivery pump. Standalone deployments keep capture disabled until a host registers a sink.
