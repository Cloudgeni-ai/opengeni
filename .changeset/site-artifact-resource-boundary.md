---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

Site-started agents need both declared editing tools and artifact resource scope. Edits and exports are limited to artifacts created within the same Site-clamped session tree, using immutable create/import receipts rather than recent-use associations. Reading an unrelated workspace artifact cannot grant editing access. Parent and child sessions can work on their tree's creations; another conversation on the same Site cannot. HTTP mutation routes and MCP apply/export/export-status enforce the same boundary. No existing-artifact declaration field is introduced.
