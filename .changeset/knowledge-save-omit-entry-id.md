---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Knowledge saves can omit `entryId` when creating an entry. OpenGeni derives the id from `operationId`, so an exact retry replays the same entry instead of creating a duplicate. The all-zero UUID is rejected. A create whose `entryId` belongs to another entry now fails with a clear "entry id taken" error (HTTP 409, `knowledge_entry_id_taken`). Previously this was reported as operation-ID reuse, so agents retried forever and the fact was never saved.
