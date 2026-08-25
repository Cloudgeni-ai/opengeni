---
"@opengeni/db": minor
"@opengeni/api-router": minor
---

Ask once where an unconfigured Slack conversation should work, remember the answer, and re-queue the request that was interrupted by the question. One live card per person per conversation is enforced by a partial unique index, an aged-out card is settled by the writer rather than holding the slot, and the answer commits the choice, the remembered route and the re-queued request together.
