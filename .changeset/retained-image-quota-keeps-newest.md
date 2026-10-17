---
"@opengeni/db": patch
---

A full workspace image quota no longer drops new images, and claims that keep failing no longer starve expiry. A full batch of failing cleanup claims was reclaimed first on every sweep, so nothing behind it expired. Fresh work is now claimed before failed claims are retried. When the quota is full, the workspace's oldest images are queued for cleanup to make room for the new one. Only an image larger than the whole quota is still refused.
