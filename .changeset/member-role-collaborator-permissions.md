---
"@opengeni/db": patch
---

Give the named shared-workspace Member role everything Viewer has plus read-or-own collaborator access: `artifacts:read` (open Sites and agent-made documents, spreadsheets and presentations), `stream:view`, `stream:acknowledge`, `rigs:use`, and `enrollments:read`. Rolling migrations 0555-0557 update the preset, normalize older named Member sets written by overlapping binaries, and backfill exact-match memberships in batches. Custom permission sets are unchanged, and administrative permissions, including human `artifacts:publish`, stay Admin-only.
