---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
---

Add an optional idle-session archive. When a deployment enables it (`OPENGENI_SESSION_ARCHIVE_ENABLED`, Helm `sessionArchive.enabled`), sessions with no activity for `OPENGENI_SESSION_ARCHIVE_IDLE_DAYS` (30 by default) move their bulky content to object storage as a verified bundle plus a readable transcript, keep their readable timeline, and become read-only. Sessions expose `retention`, and `keepLive` (on create or via `updateSessionRetention`) exempts a session permanently.
