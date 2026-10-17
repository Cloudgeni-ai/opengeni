---
"@opengeni/config": minor
---

The idle-session archive is now on by default (`OPENGENI_SESSION_ARCHIVE_ENABLED`, Helm `sessionArchive.enabled`). Sessions with no activity for 30 days move their bulky content to object storage and become read-only, which keeps PostgreSQL from growing without bound. Deployments without object storage never archive. Set `sessionArchive.enabled: false` (or `OPENGENI_SESSION_ARCHIVE_ENABLED=false`) to keep every session in PostgreSQL; an explicit `false` in a values file is respected.
