---
"@opengeni/db": patch
"@opengeni/react": patch
---

A Connected Machine whose agent process serves several workspaces no longer shows a failed agent update in the workspaces that did not start it. While one workspace's update runs, the others record a postponement (`update_busy_updating`, retried on the busy backoff and shown as waiting) instead of a failure, and once the restarted agent proves through its update receipt that it runs exactly the target build, every workspace's pending, postponed or failed update for that build is marked succeeded.
