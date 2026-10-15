---
---

Helm chart: the embedded PostgreSQL accepts server settings through `postgres.parameters`, a map rendered as `-c name=value` flags in name order. A persistent single-node install can now size `shared_buffers` and planner settings for its host or preload `pg_stat_statements`, instead of running on image defaults. Setting names are validated, and an empty map keeps the previous behaviour.
