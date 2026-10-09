---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": patch
---

Compact session list entries (`listSessionSummaryPage`) now include optional `model` and `reasoningEffort`, so navigation surfaces can name the model a session runs on without loading its detail. The value is the latest started turn's model and effort, or the session's stored default when an explicit model change is newer or no turn has started yet; it costs two fixed index probes and one primary-key lookup per row. They are display-only: `getSession` remains authoritative for the composer default. When the SDK projects an older server's full pages, the fields carry each session's effective model.
