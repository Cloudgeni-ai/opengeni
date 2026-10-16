---
"@opengeni/testing": patch
---

PostgreSQL 18 is now the default. The Helm chart's in-cluster Postgres uses `pgvector/pgvector:pg18-bookworm`, and the local development and test stacks use the same image. The backup image now ships PostgreSQL 18 clients, which also back up PostgreSQL 17 and older servers.

**Upgrading the chart with existing in-cluster data:** a new init container checks the data directory's major version before PostgreSQL starts. A PostgreSQL 17 directory does not start on the new image until you either set `postgres.image.tag: pg17` to stay on 17, or take a backup and set `postgres.majorUpgrade.enabled: true` to upgrade in place with `pg_upgrade --link` during a short outage. The old directory is kept beside the new one. See "deployment.md" for the full procedure and rollback.

**Local development:** the Docker Compose Postgres volume is now mounted at `/var/lib/postgresql`, where PostgreSQL 18 keeps a versioned data directory. An existing development volume starts as a fresh, empty PostgreSQL 18 database; the old PostgreSQL 17 files stay untouched in the volume. Native Linux development accepts PostgreSQL 18 or an existing 17.
