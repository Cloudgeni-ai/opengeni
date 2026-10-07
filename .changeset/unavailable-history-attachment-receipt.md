---
"@opengeni/worker-bundle": patch
---

In shared sessions, a history attachment that the current requester's file access does not return (another participant's file, or one that is no longer available) now gets a receipt saying it is not available to the current requester, without guessing which, and with no download instruction. Previously the receipt told the model to fetch the file, the fetch failed, and the model reported the file as deleted. The file-authority boundary is unchanged.
