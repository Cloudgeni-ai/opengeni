---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Track built-in tool default inheritance independently of connector selection. New sessions and explicit resets follow current workspace defaults on the next attempt, while explicit lists, exclusions, deployment ceilings, capability restrictions, and frozen catalogs remain authoritative. A rolling migration adopts default intent only for older root sessions whose latest retained policy event proves a full reset and still matches their stored selection; ambiguous legacy selections remain pinned.
