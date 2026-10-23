---
"@opengeni/api-router": patch
---

Batch concurrently pending command-completion lookups for the same runner process using the existing inventory classifier. This reduces database round trips for completion bursts without caching authority, changing collector concurrency, or suppressing retries for exits that race background adoption. Notification receipts and output custody are unchanged.
