---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Photo-heavy chats no longer compact over and over. After compaction only the newest user message that has attachments keeps its images inline; photos of older retained messages move to the dated attachment catalog, where the agent can reopen them, and those messages are charged only for their text. Newly sent photos are shown to every model at most 2000 px on the longest side (the file itself stays full resolution, and the receipt says so); photos sent before this change keep their original projection, so requests already sent are unchanged. The local image token estimate now prices images by the patches they cover at the sent resolution, so a full-resolution phone photo counts as about 15k tokens instead of 765.
