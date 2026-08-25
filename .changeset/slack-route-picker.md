---
"@opengeni/db": patch
---

Ask once where an unconfigured Slack conversation should work, remember the answer, and re-queue the request that was interrupted by the question. One live card per conversation is enforced by a partial unique index, and the answer commits the choice, the remembered route and the re-queued request together.
