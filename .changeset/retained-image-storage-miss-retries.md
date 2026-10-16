---
"@opengeni/worker-bundle": patch
"@opengeni/react": patch
---

A turn no longer fails for good when an image sent earlier in the conversation is briefly unreadable from object storage, for example while a storage replica catches up after an outage. The same turn now retries with the usual short backoff, shows "An image from earlier in this conversation can't be read from storage" while it waits, and sends the same pixels once the image is readable. Bytes that no longer match the stored checksum still fail the turn, because retrying cannot fix them.
