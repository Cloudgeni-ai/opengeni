---
"@opengeni/worker-bundle": patch
---

In shared sessions, a history attachment that the current requester's file access does not include (for example a file another participant shared) now gets a receipt saying it is not available to the current requester, with no download instruction. Previously the receipt told the model to fetch the file, the fetch failed, and the model reported the file as deleted. The file-authority boundary is unchanged.
