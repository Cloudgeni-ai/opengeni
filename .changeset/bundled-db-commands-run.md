---
"@opengeni/api-router": patch
---

Fix bundled database commands (migrate, provision-roles, session-content-compaction) silently doing nothing in release images: code splitting moved their `import.meta.main` entry into a shared chunk, so the release assembly now calls each command's exported runner explicitly and refuses to build an entry that would no-op.
